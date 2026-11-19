import {readFile,rm} from 'node:fs/promises';
import {renameSync} from 'node:fs';
import {extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {abortAgent,standaloneAgent} from './agent.js';
import {standaloneTranscript} from './transcript.js';
import {subscriptionSessions} from '../ai/antigravity-sessions.js';
import {pendingBusinessApprovals} from '../features/tools.js';
import {onebotPath} from '../paths.js';

export const readConfig=async()=>JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH??onebotPath('openclaw.json'),'utf8'));
const output=value=>({stdout:JSON.stringify(value),stderr:''});
export async function dispatchLocalCommand(args,options={}){
    const value=key=>args.includes(key)?args[args.indexOf(key)+1]:undefined;
    if(args[0]==='agent'){
        const route=options.onebotAiRoute;
        if(!route?.ai || route.model!==value('--model'))throw Error('Expected an explicit task step');
        const media=(options.onebotImagePaths??[]).map(path=>({path,
            contentType:({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif'})[extname(path).toLowerCase()]}));
        const response=await standaloneAgent({cfg:await readConfig(),agentId:value('--agent'),sessionKey:value('--session-key'),
            text:value('--message'),media,taskId:route.taskId,profile:route.aiProfile,selectedStep:route.ai,toolsAllow:[],
            timeoutMs:route.timeoutMs,signal:route.signal});
        return output({payloads:[{text:response.text}]});
    }
    if(args[0]==='approvals' && args[1]==='pending'){
        // These operations are reconciled and resolved by the business branch of the gateway.
        const approvals=pendingBusinessApprovals().map(item=>({id:item.id,kind:'business',sessionKey:item.origin.sessionKey}));
        return output({approvals});
    }
    if(args[0]==='gateway' && args[1]==='call'){
        const {key}=JSON.parse(value('--params'));
        const agentId=/^agent:([a-z0-9_-]+):/u.exec(key)?.[1];
        if(!agentId)throw Error('Invalid session identity');
        if(args[2]==='sessions.abort')return output({aborted:abortAgent(key)});
        if(['sessions.delete','sessions.reset'].includes(args[2])){
            abortAgent(key);
            const hard=args[2]==='sessions.delete';
            subscriptionSessions({existing:true})?.reset(key);
            standaloneTranscript().reset(agentId,key,hard);
            if(hard){
                const dir=onebotPath('state','antigravity','workspaces',createHash('sha256').update(key).digest('hex'));
                const retired=dir+'.deleted-'+randomUUID();
                try{renameSync(dir,retired);}catch(error){if(error.code!=='ENOENT')throw error;}
                await rm(retired,{recursive:true,force:true});
            }
            return output({ok:true});
        }
    }
    throw Error('Unsupported standalone operation '+args.slice(0,2).join(' '));
}
