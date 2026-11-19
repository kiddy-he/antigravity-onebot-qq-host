import {guestWorkdir} from './antigravity-isolation.js';
import {metric} from './metrics.js';
import {nativeSources} from './antigravity-sources.js';
import {AiError} from './router.js';
import {cliFailure, startCli} from './antigravity-process.js';

export function sessionSettings({tools=false}={}) {
    const deny=['read_file(*)','write_file(*)','command(*)','unsandboxed(*)','execute_url(*)','read_url(*)'];
    if (!tools) deny.push('mcp(*)');
    return JSON.stringify({useG1Credits:false,allowNonWorkspaceAccess:false,toolPermission:'strict',
        permissions:{allow:[],ask:[],deny}});
}

export async function acpTurn({cwd,model,effort,sessionId:previousId,prompt,signal,timeoutMs,executable,
    mcpServers=[],onPermission,requireSearch=false}) {
    let nextId=1, activeId, collecting=false, output='', searchCalls=new Map(), ended;
    const pending=new Map();
    if(mcpServers.length>1||mcpServers.some(s=>s.name!=='onebot'))throw new AiError('configuration_error','Unsupported MCP server');
    const bridge=mcpServers[0];
    const mcp=bridge?{script:bridge.args[0],socket:bridge.args[1]}:undefined;
    const guestServers=bridge?[{...bridge,command:'/app/node',args:['/app/onebot-mcp.mjs','/run/onebot-mcp.socket']}]:[];
    const effortArgs=['low','medium','high','xhigh','max'].includes(effort)?['--effort',effort]:[];
    const cli=startCli(['--settings',sessionSettings({tools:mcpServers.length>0}),...effortArgs,'acp','--stdio',
        '--sandbox','--include-default-customizations=false'],{cwd,signal,timeoutMs,executable,mcp,
        onAbort:()=>activeId && collecting?{jsonrpc:'2.0',method:'session/cancel',params:{sessionId:activeId}}:undefined,
        onLine(value){
        const message=JSON.parse(value);
        if(message.jsonrpc!=='2.0') throw new AiError('invalid_schema','Unexpected ACP version');
        if(message.method && message.id!=null) {
            const params=message.params??{};
            if(message.method==='session/request_permission') {
                const option=activeId && params.sessionId===activeId && collecting && onPermission?.(params);
                const approved=option && params.options?.some(o=>o.optionId===option && o.kind==='allow_once');
                cli.send({jsonrpc:'2.0',id:message.id,result:{outcome:approved?{outcome:'selected',optionId:option}:{outcome:'cancelled'}}});
            } else cli.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported client method'}});
        } else if(message.id!=null) {
            const waiter=pending.get(message.id);
            if(!waiter) return;
            pending.delete(message.id);
            if(message.error) waiter.reject(cliFailure(message.error.message));
            else waiter.resolve(message.result);
        } else if(collecting && message.method==='session/update' && message.params?.sessionId===activeId) {
            const u=message.params.update;
            if(u.sessionUpdate==='agent_message_chunk' && u.content?.type==='text') {
                // Native retry diagnostics use the same event type as reply text.
                if(/^\s*⚠(?:️)? API error \(attempt \d+\):/u.test(u.content.text)) return;
                output+=u.content.text;
                if(Buffer.byteLength(output)>4*1024*1024) throw new AiError('incomplete_output');
            }
            if(requireSearch && ['tool_call','tool_call_update'].includes(u.sessionUpdate)){
                const call={...searchCalls.get(u.toolCallId),...u};
                searchCalls.set(u.toolCallId,call);
            }
        }
    }});
    function terminate(error) {
        ended=error??new AiError('network_error','CLI disconnected');
        for(const p of pending.values()) p.reject(ended);
        pending.clear();
    }
    cli.done.then(()=>terminate(),terminate);
    function rpc(method,params) {
        if(ended) throw ended;
        const id=nextId++;
        return new Promise((resolve,reject)=>{
            pending.set(id,{resolve,reject});
            cli.send({jsonrpc:'2.0',id,method,params});
        });
    }
    try {
        const hello=await rpc('initialize',{protocolVersion:1,clientInfo:{name:'onebot',version:'1'},clientCapabilities:{}});
        if(hello.protocolVersion!==1 || !hello.authMethods?.some(m=>m.id==='oauth-personal')) throw new AiError('configuration_error','Unsupported ACP service');
        let setup;
        if(previousId) {
            activeId=previousId;
            setup=await rpc('session/load',{cwd:guestWorkdir,sessionId:activeId,mcpServers:guestServers});
        } else {
            setup=await rpc('session/new',{cwd:guestWorkdir,mcpServers:guestServers});
            activeId=setup.sessionId;
        }
        if(!activeId) throw new AiError('invalid_schema','Missing ACP session');
        if(!setup.models?.availableModels?.some(m=>m.modelId===model)) throw new AiError('model_unavailable');
        const reload=()=>rpc('session/load',{cwd:guestWorkdir,sessionId:activeId,mcpServers:guestServers});
        if(setup.models.currentModelId!==model){
            await rpc('session/set_model',{sessionId:activeId,modelId:model});
            setup=await reload();
            if(setup.models?.currentModelId!==model)throw new AiError('model_unavailable','Native model selection was not applied');
        }
        const option=(session,id)=>session.configOptions?.find(item=>item.id===id);
        const requestedEffort=effortArgs[1];
        if(requestedEffort && option(setup,'thought_level')?.currentValue!==requestedEffort){
            const family=option(setup,'model')?.currentValue,level=option(setup,'thought_level');
            if(!family || !level?.options?.some(entry=>entry.value===requestedEffort))
                throw new AiError('configuration_error','Native model does not advertise the requested thinking level');
            // ACP model selection can reset --effort to the level in the model ID.
            await rpc('session/set_config_option',{sessionId:activeId,configId:'thought_level',value:requestedEffort});
            setup=await reload();
            if(option(setup,'model')?.currentValue!==family || option(setup,'thought_level')?.currentValue!==requestedEffort ||
                !setup.models?.availableModels?.some(entry=>entry.modelId===setup.models.currentModelId))
                throw new AiError('configuration_error','Native session did not confirm the model family and thinking level');
        }
        collecting=true;
        metric('native-session',{resumed:Boolean(previousId),model:setup.models.currentModelId,search:requireSearch===true});
        const result=await rpc('session/prompt',{sessionId:activeId,prompt});
        collecting=false;
        if(result.stopReason!=='end_turn') throw new AiError(result.stopReason==='cancelled'?'cancelled':'incomplete_output');
        if(!output.trim()) throw new AiError('empty_output');
        if(requireSearch)metric('native-search',{completed:[...searchCalls.values()].some(call=>call.name==='search_web'&&call.status==='completed')});
        const sources=requireSearch?await nativeSources(searchCalls.values(),output,prompt,signal):undefined;
        return {text:output,complete:true,sessionId:activeId,nativeModel:setup.models.currentModelId,effort:option(setup,'thought_level')?.currentValue,usage:result.usage,...(sources?{sources}:{})};
    } finally {
        collecting=false;
        // On failure or cancellation no new SDK/CLI turn will reuse this process.
        // Session history persists under its native ID after the stdio client exits.
        cli.end(); cli.kill(); await cli.done.catch(()=>{});
    }
}
