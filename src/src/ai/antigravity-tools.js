import {registerFeatureToolGuard,trustedFeatureContext} from '../feature-tools.js';
import {BUSINESS_TOOLS} from '../features/catalog.js';
import {registerBusinessTools} from '../features/tools.js';
import {registerTaskProgressHooks} from '../task-progress.js';
import {trustedServiceContext} from '../access/services.js';

const bindings=new Map(),guards=[];
const registration={
    registerTool(factory,{names}){for(const name of names)bindings.set(name,factory);},
    on(name,fn){if(name==='before_tool_call')guards.push(fn);},
};
registerFeatureToolGuard(registration);
registerBusinessTools(registration);
const progress={};
registerTaskProgressHooks({on:(name,fn)=>{progress[name]=fn;}});

export function businessTurnTools(sessionKey,runId,{allow,onExecuting,onTerminal,additionalNames=[],resolveAdditional}={}) {
    const context=()=>trustedFeatureContext(sessionKey)??trustedServiceContext(sessionKey);
    const inbound=trustedFeatureContext(sessionKey);
    const original=inbound??trustedServiceContext(sessionKey);
    if(!original)return;
    const ctx={sessionKey,runId,requester:{senderId:original.senderId,accountId:original.accountId,channel:'onebot'}};
    const identity=c=>JSON.stringify([c?.requestId,c?.originJobId,c?.accountId,c?.senderId,c?.groupId,c?.workspaceAgentId]);
    const stillCurrent=()=>inbound?trustedFeatureContext(sessionKey)===inbound:identity(context())===identity(original);
    const initial=new Map();
    const resolve=(name,ownedProcess=false)=>bindings.has(name)?bindings.get(name)(ownedProcess?{...ctx,onebotOwnedProcess:true}:ctx):resolveAdditional?.(name);
    for(const name of [...bindings.keys(),...additionalNames]){
        if(allow && !allow.has(name))continue;
        const tool=resolve(name);if(tool)initial.set(name,tool);
    }
    // Compatibility actions belong to the live owner exec grant. They have no
    // direct MCP entry and cannot be selected by passing flags in tool arguments.
    function grantedTool(name,ownedProcess=false){
        if(BUSINESS_TOOLS[name]?.ownerCommand){
            if(!ownedProcess || !initial.has('exec') || !resolve('exec'))return;
            return resolve(name,true);
        }
        return initial.has(name) && resolve(name,ownedProcess);
    }
    return {
        ownerRequestedQuotaRefresh: inbound?.scope==='private' && !inbound.internal && inbound.ownerRequestedQuotaRefresh===true,
        list(names){
            if(!stillCurrent())return [];
            // A poll may outlive its original feature grant. Resolve those particular
            // business tools against the current policy before returning a stored result.
            const visible=names?names.map(name=>grantedTool(name,true)).filter(Boolean):
                [...initial.values()].filter(t=>bindings.has(t.name)||resolve(t.name));
            return visible.map(t=>({name:t.name,description:t.description,inputSchema:t.parameters}));
        },
        async call(name,params,id,signal,{ownedProcess=false}={}){
            signal.throwIfAborted();
            const tool=stillCurrent()&&grantedTool(name,ownedProcess);
            if(!tool)throw new Error('Tool grant expired');
            const toolCallId=runId+'-'+id;
            const event={toolName:name,params,toolCallId};
            onExecuting?.(name);
            for(const guard of guards){
                const decision=await guard(event,ctx);
                if(decision?.block)return {isError:true,content:[{type:'text',text:decision.blockReason}]};
            }
            signal.throwIfAborted();
            if(!stillCurrent())throw new Error('Tool grant expired');
            await progress.before_tool_call(event,ctx);
            if(!stillCurrent())throw new Error('Tool grant expired');
            const result=await tool.execute(toolCallId,params,signal);
            await progress.after_tool_call({...event,result},ctx);
            onTerminal?.({toolCallId,toolName:name,arguments:params,executionStarted:true,outcome:result.isError?'failure':'success'});
            return result;
        },
    };
}
