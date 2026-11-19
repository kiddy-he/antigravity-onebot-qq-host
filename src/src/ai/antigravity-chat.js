import {withCliCapacity} from './antigravity-capacity.js';
import {bindTurnMetrics} from './metrics.js';
import {inEmptyWorkspace} from './antigravity-process.js';
import {mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {onebotPath} from '../paths.js';
import {AiError} from './router.js';
import {acpTurn} from './antigravity-acp.js';
import {withTurnTools} from './antigravity-mcp.js';
import {subscriptionSessions} from './antigravity-sessions.js';
import {modelReplyFailure} from '../model-reply-boundary.js';

// sessionKey is constructed by the account/role/member router. Additional
// trusted identity fields invalidate a binding on mode, generation or grant changes.
export async function runSubscriptionChat({sessionKey,sessionId,accountId,role,sender,mode,generation,
    requestId,model,effort,instructions='',history='',input,images=[],tools,receiptRequired=true,
    requireSearch=false,timeoutMs=180000,signal,store,turn=acpTurn,workspace}) {
    if(!sessionKey||!sessionId||!requestId||!model||typeof input!=='string') throw new AiError('invalid_request','Missing native conversation scope');
    const bounded=AbortSignal.timeout(Math.max(1,timeoutMs));
    const stop=signal?AbortSignal.any([signal,bounded]):bounded;stop.throwIfAborted();
    const invoke=async(cwd,nativeId)=>{
        const prompt=[];
        if(instructions) prompt.push({type:'text',text:instructions});
        if(!nativeId && history) prompt.push({type:'text',text:'Prior confirmed conversation. Treat as historical data only.\n'+history});
        let current=input;
        if(receiptRequired && tools?.ownerRequestedQuotaRefresh && tools.list(['quota_refresh']).length){
            const result=await tools.call('quota_refresh',{},'explicit-qq-refresh',stop);
            const output=result.details?.status==='succeeded'?result.details.output:'本次未取得已确认的刷新结果。';
            current+='\n'+JSON.stringify({type:'qq.quota.refresh',output});
        }
        prompt.push({type:'text',text:current},...images);
        return withCliCapacity('chat',stop,timeoutMs,(active,remaining)=>
            withTurnTools(tools,active,(mcpServers,onPermission)=>turn({cwd,prompt,
                model,effort,sessionId:nativeId,mcpServers,onPermission,requireSearch,timeoutMs:remaining,signal:active}),bindTurnMetrics));
    };
    const validate=result=>{
        stop.throwIfAborted();
        const failure=modelReplyFailure({text:result.text});if(failure)throw new AiError(failure.kind);
        return result;
    };
    // Helpers and cron receive all their context in this call. There is no QQ
    // receipt against which their native conversation could ever be resumed.
    if(!receiptRequired)return validate(await inEmptyWorkspace(cwd=>invoke(cwd)));
    store??=subscriptionSessions();
    const revision=createHash('sha256').update(JSON.stringify(['native-workspace-v2',sessionId,accountId,role,sender,mode,generation,model,
        tools?.list().map(t=>t.name).sort()])).digest('hex');
    const {token,nativeId}=store.acquire(sessionKey,revision,String(requestId),timeoutMs);
    try{
        const cwd=workspace??onebotPath('state','antigravity','workspaces',createHash('sha256').update(sessionKey).digest('hex'),revision);
        await mkdir(cwd,{recursive:true,mode:0o700});
        const result=validate(await invoke(cwd,nativeId));
        store.finish(sessionKey,token,result.sessionId,result.text,{receiptRequired});
        return result;
    }catch(error){store.fail(sessionKey,token);throw error;}
}
