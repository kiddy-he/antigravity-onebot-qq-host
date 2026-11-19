import {readFileSync} from 'node:fs';
import {onebotPath} from '../paths.js';
import {digest} from '../access/operations.js';
import {loadWorkspaceRoutes} from '../workspaces/routes.js';
import {standaloneTranscript} from './transcript.js';
import {toolAllowed} from './tool-grants.js';

export function processOwner({actor,sessionKey,generation}){
    if(actor.scope!=='private'||!actor.accountId||!actor.senderId||!actor.workspaceAgentId||!sessionKey||!generation)throw Error('缺少管理操作归属');
    return digest([actor.accountId,String(actor.senderId),actor.workspaceAgentId,sessionKey,generation]);
}

export function currentOwnerGrant(sessionKey,actor,owner){
    const agent=actor.workspaceAgentId,route=loadWorkspaceRoutes().agents[agent];
    if(!route || route.scope!=='private' || route.purpose!=='main' || route.accountId!==actor.accountId ||
        String(route.conversationId)!==String(actor.senderId))return false;
    const cfg=JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH??onebotPath('openclaw.json'),'utf8'));
    const entry=cfg.agents.entries?.[agent];
    if(!entry)return false;
    const exec={...cfg.tools?.exec,...entry.tools?.exec};
    if(exec.host!=='gateway'||exec.mode!=='ask'||!toolAllowed('exec',cfg.tools)||!toolAllowed('exec',entry.tools))return false;
    const generation=standaloneTranscript().currentGeneration(agent,sessionKey);
    return Boolean(generation) && processOwner({actor,sessionKey,generation})===owner;
}
