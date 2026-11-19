import {withCliCapacity} from './antigravity-capacity.js';
import {AiError} from './router.js';
import {acpTurn, sessionSettings} from './antigravity-acp.js';
import {inEmptyWorkspace, startCli, cliFailure} from './antigravity-process.js';
import {modelReplyFailure} from '../model-reply-boundary.js';

export const CLI_ADAPTER='antigravity-cli';

export function taskPrompt(input) {
    const messages=input?.messages??[
        {role:'system',content:input?.instruction??'Return JSON only.'},
        {role:'user',content:typeof input==='string'?input:typeof input?.value==='string'?input.value:JSON.stringify(input?.value??input)},
    ];
    if(!Array.isArray(messages)||!messages.length) throw new AiError('invalid_request');
    const images=[];
    const transcript=messages.map(({role,content})=>{
        if(!['system','developer','user','assistant','tool'].includes(role)) throw new AiError('invalid_request');
        if(typeof content==='string') return {role,content};
        if(!Array.isArray(content)) throw new AiError('invalid_request');
        const parts=content.map(p=>{
            if(['text','input_text','output_text'].includes(p.type)&&typeof p.text==='string') return {text:p.text};
            const value=typeof p.image_url==='string'?p.image_url:p.image_url?.url;
            const match=/^data:(image\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/u.exec(value??'');
            if(!['image_url','input_image'].includes(p.type)||!match) throw new AiError('invalid_request','Expected an inline image');
            images.push({type:'image',mimeType:match[1],data:match[2].replace(/\s/gu,'')});
            return {image:images.length};
        });
        return {role,content:parts};
    });
    return [{type:'text',text:'Execute the task in the following role-labelled conversation. Apply system and developer instructions to the supplied inputs. Return only the requested output.\n'+JSON.stringify(transcript)},...images];
}

async function headless({cwd,prompt,model,effort,json,schema,signal,timeoutMs,executable}) {
    const args=['--settings',sessionSettings(),'--sandbox','--disable-slash-commands','--model',model,
        '--input-format','stream-json','--output-format','stream-json'];
    if(['low','medium','high','xhigh','max'].includes(effort)) args.push('--effort',effort);
    if(schema) args.push('--json-schema',JSON.stringify(schema));
    let result;
    const cli=startCli(args,{cwd,signal,timeoutMs,executable,onLine(line){
        const event=JSON.parse(line);
        if(event.event==='result'){
            if(result) throw new AiError('invalid_schema','Multiple CLI results');
            result=event.result;
            if(result?.error) throw cliFailure(result.error);
        }
    }});
    try {
        cli.send({event:'user',message:{content:prompt[0].text+(json?'\nReturn exactly one JSON object, without Markdown.':'')}});
        cli.end();
        await cli.done;
    } finally { cli.kill(); }
    if(!result) throw new AiError('incomplete_output');
    if(result.status!=='SUCCESS') throw cliFailure(result.error??result.status);
    let text=result.response;
    if(json || schema) {
        let parsed;
        try { parsed=schema?result.structured_output:JSON.parse(text.trim()); }
        catch { throw new AiError('invalid_schema'); }
        if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new AiError('invalid_schema');
        text=JSON.stringify(parsed);
    }
    return {text,
        usage:result.usage,sessionId:result.conversation_id,complete:true};
}

export async function invokeCliStep(step, options={}) {
    const prompt=taskPrompt(step.input);
    const lane=/review/u.test(step.taskId??'')?'review':'task';
    return withCliCapacity(lane,step.signal,step.timeoutMs??90000,(signal,timeoutMs)=>inEmptyWorkspace(async cwd=>{
        const requireSearch=step.parameters?.nativeSearch===true;
        if(requireSearch) prompt.push({type:'text',text:'Use the native search_web tool. For source verification, append its original Google grounding redirect URLs exactly as returned, one per line. Do not use commands or files.'});
        const effort=step.parameters?.thinking??step.thinking??step.deployment.thinking;
        const params={cwd,prompt,model:step.deployment.model,effort,signal,timeoutMs,
            executable:options.executable};
        const result=prompt.length>1 || requireSearch
            ? await acpTurn({...params,requireSearch})
            : await headless({...params,json:step.parameters?.responseFormat==='json',schema:step.context?.outputSchema});
        if(typeof result.text!=='string'||!result.text.trim()) throw new AiError('empty_output');
        const failure=modelReplyFailure({text:result.text});
        if(failure) throw new AiError(failure.kind);
        return result;
    }));
}
