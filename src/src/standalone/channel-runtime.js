import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {basename,dirname,join} from 'node:path';
import {standaloneAgent} from './agent.js';
import {onebotPath} from '../paths.js';
import {trustedFeatureContext} from '../feature-tools.js';
import {businessMediaAuthorization} from '../features/tools.js';
import {operationStore} from '../access/operations.js';

function completedArtifact(sessionKey,path,actor){
    const store=operationStore();
    const hash=/^([a-f0-9]{64})\.[a-z0-9]{1,8}$/u.exec(basename(path))?.[1];
    if(!hash || path!==join(onebotPath('media','outbound','onebot'),basename(path)))return null;
    // The producer preserves file extensions. Identical content can have more
    // than one name in the managed directory while the ledger keys by hash.
    const entry=store.db.prepare('SELECT path FROM artifacts WHERE hash=?').get(hash);
    return entry && dirname(entry.path)===dirname(path) && businessMediaAuthorization(sessionKey,path,actor,store);
}

// Only turn-owned attachments and completed business artifacts can become QQ
// media. The model's text alone cannot authorize opening a path on the host.
export function standaloneReplyPayload(text,sessionKey,actor,authorize=completedArtifact){
    const lines=[],media=new Set();
    let rejected=false,fence='';
    for(const line of text.split('\n')){
        const marker=/^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
        if(marker && (!fence || (marker[0]===fence[0] && marker.length>=fence.length)))fence=fence?'':marker;
        const match=!fence && /^\s*MEDIA:\s*(\/[^\x00-\x1f]+?)\s*$/u.exec(line);
        if(!match){lines.push(line);continue;}
        const path=match[1];
        if(actor && (actor.mediaPaths?.includes(path)||authorize(sessionKey,path,actor)))media.add(path);
        else rejected=true;
    }
    if(!rejected && !media.size)return {text};
    const remaining=lines.join('\n').trim();
    return {text:remaining||(!media.size&&rejected?'本次附件未取得发送授权。':''),...(media.size?{mediaUrls:[...media]}:{})};
}

export function standaloneChannel(hooks,log){
    return {channel:{
        activity:{record(){}},
        routing:{resolveAgentRoute({accountId,peer}){
            const role=accountId==='yuexia'?'onebot-yuexia':'main';
            const sessionKey='agent:'+role+':onebot:'+peer.kind+':'+peer.id;
            return {accountId,agentId:role,sessionKey,mainSessionKey:'agent:'+role+':main',lastRoutePolicy:'session'};
        }},
        media:{async saveMediaBuffer(data,contentType,area,maxBytes){
            if(area!=='inbound'||data.length>maxBytes)throw Error('Inbound media too large');
            const suffix={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'}[contentType]??'bin';
            const dir=onebotPath('media','inbound');await mkdir(dir,{recursive:true,mode:0o700});
            const path=join(dir,randomUUID()+'.'+suffix);
            await writeFile(path,data,{flag:'wx',mode:0o600});return {path,contentType};
        }},
        reply:{
            resolveEffectiveMessagesConfig:cfg=>cfg.messages??{},resolveEnvelopeFormatOptions:()=>({}),
            formatAgentEnvelope:({body})=>body,finalizeInboundContext:ctx=>ctx,
            async dispatchReplyWithBufferedBlockDispatcher({ctx,cfg,dispatcherOptions,replyOptions={},onebotTask}){
                const sessionKey=ctx.SessionKey,agentId=ctx.AgentId,requestId=String(ctx.MessageSid??randomUUID());
                const scope={sessionKey,agentId,runId:requestId,accountId:ctx.AccountId,config:cfg};
                const prompt=ctx.BodyForAgent??ctx.Body??ctx.RawBody;
                const contributions=await hooks('before_prompt_build',{prompt,messages:[]},scope);
                const system=contributions.flatMap(c=>[c.prependSystemContext,c.appendSystemContext]).filter(Boolean).join('\n\n');
                const input=[...contributions.map(c=>c.prependContext),prompt,...contributions.map(c=>c.appendContext)].filter(Boolean).join('\n\n');
                const actor=trustedFeatureContext(sessionKey);
                const result=await standaloneAgent({cfg,sessionKey,agentId,text:input,media:ctx.media,requestId,
                    taskId:onebotTask?.taskId,profile:onebotTask?.profile,routeIndex:onebotTask?.routeIndex,
                    toolsAllow:replyOptions.toolsAllow,timeoutMs:(replyOptions.timeoutOverrideSeconds??180)*1000,
                    signal:replyOptions.abortSignal,stableInstructions:system,requireSearch:replyOptions.openclawGeminiWebSearch===true});
                replyOptions.abortSignal?.throwIfAborted();
                const current=actor===trustedFeatureContext(sessionKey)?actor:null;
                await dispatcherOptions.deliver(standaloneReplyPayload(result.text,sessionKey,current),{kind:'final'});
                log?.debug?.('Standalone reply completed for '+result.deploymentId);
                return {queuedFinal:true,counts:{final:1,block:0,tool:0}};
            },
        },
    }};
}
