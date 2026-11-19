import {randomUUID} from 'node:crypto';
import {AiError,decodeText,requestShape} from '../ai/router.js';
import {requestTaskBody} from '../ai/client.js';

function advertised(adapter,items){
    if(adapter==='gemini-native')return [{functionDeclarations:items.map(t=>({name:t.name,description:t.description,parametersJsonSchema:t.inputSchema}))}];
    if(adapter==='anthropic-messages')return items.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema}));
    const definitions=items.map(t=>({name:t.name,description:t.description,parameters:t.inputSchema}));
    return definitions.map(fn=>adapter==='openai-chat'?{type:'function',function:fn}:{type:'function',...fn});
}
function imageUrl(image){
    return 'data:'+image.mimeType+';base64,'+image.data;
}

function toolResult(result,vision){
    const content=result.content??[],pictures=content.filter(part=>part.type==='image');
    if(!pictures.length)return {text:JSON.stringify(content),images:[],error:result.isError===true};
    const images=vision?pictures:[];
    const text=content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
    if(pictures.length && !vision)return {text:[text,'当前模型不支持工具返回的图片。'].filter(Boolean).join('\n'),images,error:true};
    return {text,images,error:result.isError===true};
}

function exchange(adapter,raw,body,followupImages){
    if(adapter==='openai-chat'){
        const m=raw.choices?.[0]?.message;
        if(raw.choices?.[0]?.finish_reason!=='tool_calls' || !m?.tool_calls?.length)return [];
        body.messages.push(m);
        return m.tool_calls.map(t=>({id:t.id,name:t.function.name,args:JSON.parse(t.function.arguments),
            reply:({text,images})=>{
                body.messages.push({role:'tool',tool_call_id:t.id,content:text||(images.length?'图片见本批工具结果后的消息。':'')});
                if(images.length)followupImages.push({type:'text',text:'Tool result '+t.id},
                    ...images.map(image=>({type:'image_url',image_url:{url:imageUrl(image)}})));
            }}));
    }
    if(adapter==='openai-responses'){
        const calls=raw.output?.filter(t=>t.type==='function_call');
        if(raw.status!=='completed'||!calls?.length)return [];
        body.input.push(...raw.output.filter(t=>['function_call','reasoning','message'].includes(t.type)));
        return calls.map(t=>({id:t.call_id,name:t.name,args:JSON.parse(t.arguments),
            reply:({text,images})=>body.input.push({type:'function_call_output',call_id:t.call_id,
                output:images.length?[...(text?[{type:'input_text',text}]:[]),...images.map(image=>({type:'input_image',image_url:imageUrl(image)}))]:text})}));
    }
    if(adapter==='anthropic-messages'){
        if(raw.stop_reason!=='tool_use')return [];
        const calls=raw.content?.filter(t=>t.type==='tool_use')??[];
        if(!calls.length)return [];
        const results=[];
        body.messages.push({role:'assistant',content:raw.content},{role:'user',content:results});
        return calls.map(t=>({id:t.id,name:t.name,args:t.input,
            reply:({text,images,error})=>results.push({type:'tool_result',tool_use_id:t.id,is_error:error,
                content:images.length?[...(text?[{type:'text',text}]:[]),...images.map(image=>({type:'image',source:{type:'base64',media_type:image.mimeType,data:image.data}}))]:text})}));
    }
    const candidate=raw.candidates?.[0];
    const calls=candidate?.content?.parts?.filter(p=>p.functionCall).map(p=>p.functionCall);
    if(candidate?.finishReason!=='STOP'||!calls?.length)return [];
    const parts=[];
    body.contents.push(candidate.content,{role:'user',parts});
    return calls.map(t=>({id:t.id??randomUUID(),name:t.name,args:t.args??{},
        reply:({text,images})=>parts.push({functionResponse:{name:t.name,response:{result:text},...(t.id?{id:t.id}:{}),
            ...(images.length?{parts:images.map(image=>({inlineData:{mimeType:image.mimeType,data:image.data}}))}:{})}})}));
}

export async function providerAgent(step,tools,{config,request}={}){
    const adapter=step.provider.adapter,{url,body}=requestShape(step);
    const available=tools?.list()??[],allowed=new Set(available.map(t=>t.name));
    if(available.length)body.tools=[...(body.tools??[]),...advertised(adapter,available)];
    const seen=new Map();
    for(let round=0;round<32;round++){
        step.signal.throwIfAborted();
        const raw=await requestTaskBody(step,url,body,{config,request});
        const followupImages=[];
        const calls=exchange(adapter,raw,body,followupImages);
        if(!calls.length)return {text:decodeText(raw,adapter),complete:true,actualModel:raw.modelVersion??raw.model,usage:raw.usage??raw.usageMetadata};
        for(const call of calls){
            step.signal.throwIfAborted();
            if(typeof call.id!=='string'||!allowed.has(call.name)||!call.args||typeof call.args!=='object'||Array.isArray(call.args))
                throw new AiError('authorization_denied','Invalid tool request');
            const signature=JSON.stringify([call.name,call.args]),prior=seen.get(call.id);
            if(prior && prior.signature!==signature)throw new AiError('authorization_denied','Tool identity reused');
            const result=prior?.result??await tools.call(call.name,call.args,call.id,step.signal);
            seen.set(call.id,{signature,result});
            call.reply(toolResult(result,step.deployment.capabilities?.includes('vision')));
        }
        // Chat Completions requires every tool response before the next user message.
        if(followupImages.length)body.messages.push({role:'user',content:followupImages});
    }
    throw new AiError('incomplete_output','Agent tool limit reached');
}
