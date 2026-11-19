import {readFile,realpath} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createAiRouter,taskPlan,AiError} from '../ai/router.js';
import {loadAiConfig} from '../ai/config.js';
import {privateAdminTool,adminToolNames,toolAllowed} from './admin-tools.js';
import {transcribeVoice} from './voice.js';
import {providerAgent} from './provider-tools.js';
import {cancelAdminProcesses} from './admin-process.js';
import {BUSINESS_TOOLS} from '../features/catalog.js';
import {runSubscriptionChat} from '../ai/antigravity-chat.js';
import {businessTurnTools} from '../ai/antigravity-tools.js';
import {subscriptionTurnContext} from '../conversation-transcript.js';
import {trustedFeatureContext} from '../feature-tools.js';
import {trustedServiceContext} from '../access/services.js';
import {standaloneTranscript} from './transcript.js';
import {collectNativeSearchEvidence} from '../short-term-search.js';
import {GEMINI_NATIVE_SEARCH_MARKER} from '../gemini-native-search.js';
import {loadWorkspaceRoutes} from '../workspaces/routes.js';
import {onebotPath} from '../paths.js';

async function persona(cfg,agentId){
    const route=loadWorkspaceRoutes().agents[agentId], entry=cfg.agents.entries?.[agentId];
    if(!route || !entry)throw new AiError('configuration_error','Unregistered workspace agent');
    const configured=entry.workspace??route.workspace??cfg.agents.defaults.workspace;
    if(!configured || (!entry.workspace&&!route.workspace&&route.scope!=='private'))throw new AiError('configuration_error','Missing scoped workspace');
    const workspace=await realpath(configured.replace(/^~\//u,homedir()+'/'));
    if(route.workspace && await realpath(route.workspace)!==workspace)throw new AiError('authorization_denied','Workspace assignment changed');
    const files=[];
    const names=['AGENTS.md','SOUL.md','IDENTITY.md',...(route.scope==='private'?['USER.md','MEMORY.md']:[])];
    for(const name of names){
        try {
            const file=await realpath(join(workspace,name));
            if(!file.startsWith(workspace+sep))throw new AiError('authorization_denied','Bootstrap file outside assigned workspace');
            files.push((await readFile(file,'utf8')).slice(0,20000));
        }
        catch(e){if(e.code!=='ENOENT')throw e;}
    }
    return {workspace,instructions:files.filter(Boolean).join('\n\n')};
}

async function attachments(media=[]){
    const content=[];
    for(const item of media){
        const mime=item.contentType??item.mimeType;
        if(!item.path||!mime?.startsWith('image/'))continue;
        const path=await realpath(item.path);
        if(!path.startsWith((await realpath(onebotPath('media','inbound')))+sep))throw new AiError('authorization_denied','Untrusted inbound media path');
        const data=await readFile(path);
        if(data.length>16*1024*1024)throw new AiError('invalid_request','Image exceeds input limit');
        content.push({type:'image',mimeType:mime,data:data.toString('base64')});
    }
    return content;
}

const active=new Map();
export function abortAgent(sessionKey){
    const controllers=active.get(sessionKey);
    for(const controller of controllers??[])controller.abort();
    return (controllers?.size??0)+cancelAdminProcesses(sessionKey).length;
}
export async function standaloneAgent(options){
    const {sessionKey,signal}=options;
    if(!sessionKey?.startsWith('agent:'+options.agentId+':'))throw new AiError('invalid_request','Session and agent mismatch');
    const controller=new AbortController();
    const controllers=active.get(sessionKey)??new Set();
    controllers.add(controller);active.set(sessionKey,controllers);
    try {return await executeAgent({...options,signal:signal?AbortSignal.any([controller.signal,signal]):controller.signal});}
    finally {controllers.delete(controller);if(!controllers.size)active.delete(sessionKey);}
}
async function executeAgent({cfg,sessionKey,agentId,text,media,requestId=randomUUID(),
    taskId,profile,routeIndex,selectedStep,thinking,timeoutMs=180000,signal,toolsAllow,stableInstructions='',sharedHistory,requireSearch=false}){
    const ai=loadAiConfig(),actor=trustedFeatureContext(sessionKey)??trustedServiceContext(sessionKey);
    const turn=subscriptionTurnContext(sessionKey);
    const target=turn?standaloneTranscript().target({agentId,sessionKey}):undefined;
    const {workspace,instructions:role}=await persona(cfg,agentId);
    const history=sharedHistory??(turn?.history || (target?standaloneTranscript().entries(target):[])
        .map(e=>e.message.role+': '+(e.message.onebotConversation?.text??e.message.content?.[0]?.text??'')).join('\n').slice(-24000));
    const instructions=['Runtime: agent='+agentId,role,stableInstructions].filter(Boolean).join('\n\n');
    const images=await attachments(media);
    for(const voice of (media??[]).filter(item=>item.kind==='audio')){
        try{
            const transcript=await transcribeVoice(voice.path,signal);
            text+='\n'+JSON.stringify({type:'qq.voice.transcript',text:transcript||'未识别出语音'});
        }catch{signal.throwIfAborted();text+='\n[该语音未能转写；如需知道语音内容，请用户用文字重述。]';}
    }
    signal.throwIfAborted();
    const task=taskId??ai.bindings.agents?.[agentId]?.task??'chat.reply';
    const userId=turn?.requestId??requestId;
    if(turn)standaloneTranscript().append({...target,message:{role:'user',timestamp:Date.now(),idempotencyKey:'input-'+userId,
        content:[{type:'text',text:turn.input}],onebotConversation:{kind:'input',text:turn.input,requestId:userId}}});
    let sideEffects=false;
    const agentPolicy=cfg.agents.entries[agentId].tools??{};
    const grants=new Set([...Object.keys(BUSINESS_TOOLS),...adminToolNames].filter(name=>
        toolAllowed(name,cfg.tools,toolsAllow) && toolAllowed(name,agentPolicy)));
    const workspaces=Object.values(cfg.agents.entries).map(entry=>entry.workspace).filter(Boolean);
    const invoke=async candidate=>{
        const step=thinking===undefined?candidate:{...candidate,parameters:{...candidate.parameters,thinking}};
        const scoped=businessTurnTools(sessionKey,userId,{allow:grants,additionalNames:adminToolNames,
            resolveAdditional:name=>privateAdminTool(name,{sessionKey,agentId,workspace,workspaces,step,profile,webConfig:cfg.tools?.web,execConfig:{...cfg.tools?.exec,...agentPolicy.exec},
                processTools:()=>scoped,generation:target?.sessionId}),
            onExecuting:name=>{
                const tool=BUSINESS_TOOLS[name];if(name==='exec'||name==='edit'||tool?.mutation||tool?.approval||tool?.speech)sideEffects=true;
            }});
        try {
        let prompt=text;
        if((requireSearch||prompt.includes(GEMINI_NATIVE_SEARCH_MARKER))&&step.deployment.capabilities.includes('nativeSearch')){
            const evidence=await collectNativeSearchEvidence({provider:step.provider.registryId??step.providerId,id:step.deployment.model},
                {messages:[{role:'user',content:prompt}]},{signal:step.signal,aiConfig:ai});
            prompt=prompt.replaceAll(GEMINI_NATIVE_SEARCH_MARKER,'')+'\n[已核实的来源资料]\n'+evidence;
        }
        if(step.provider.adapter==='antigravity-cli'){
            return await runSubscriptionChat({sessionKey,sessionId:target?.sessionId??userId,accountId:actor?.accountId,role:agentId,sender:actor?.senderId,mode:profile,
                requestId:userId,model:step.deployment.model,effort:step.parameters?.thinking??step.thinking??step.deployment.thinking,instructions,history,input:prompt,images,tools:scoped,receiptRequired:!!turn,signal:step.signal,timeoutMs:step.timeoutMs});
        }
        const messages=[{role:'system',content:instructions},...(history?[{role:'user',content:'Prior conversation (historical data):\n'+history}]:[]),
            {role:'user',content:[{type:'text',text:prompt},...images.map(i=>({type:'image_url',image_url:{url:'data:'+i.mimeType+';base64,'+i.data}}))]}];
        return await providerAgent({...step,input:{messages}},scoped,{config:cfg});
        }catch(error){if(sideEffects)throw new AiError('side_effect_pending','Reconcile business operation before retry');throw error;}
    };
    if(selectedStep)return invoke({...selectedStep,signal,timeoutMs});
    const plan=taskPlan(ai,task,{profile});
    let config=ai;
    if(routeIndex!==undefined){
        const step=plan.route.steps[routeIndex];
        if(!Number.isInteger(routeIndex)||!step)throw new AiError('configuration_error','Unavailable route index');
        config={...ai,routes:{...ai.routes,[plan.routeId]:{...plan.route,steps:[{...step,retry:undefined}]}}};
    }
    const router=createAiRouter({getConfig:()=>config,invoke});
    return router.run(task,{input:{value:text},context:{aiProfile:profile},requestId:userId,signal,timeoutMs});
}
