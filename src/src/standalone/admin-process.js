import {onebotPath as publicPath} from '../paths.js';
import {setTimeout as delay} from 'node:timers/promises';
import {digest,operationStore} from '../access/operations.js';
import {cancelApprovedOwnerProcesses} from '../features/owned-process.js';
import {ownerImageDirectory,parseImageExport} from '../features/owner-attachments.js';
import {maintenanceRequest} from '../features/owner-maintenance.js';
import {inspectionPlan} from '../features/owner-inspection.js';
import {processOwner as ownerKey} from './owner-grant.js';
import {prepareBusinessTool} from '../features/tools.js';

const script=publicPath("workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh");
const active=new Map();

// Match the legacy trusted-script approval forms. Arguments are passed to the
// registered business tool as data and never reparsed by a shell.
export function registeredCommand(command){
    if(typeof command==='string' && /^(?:probe-model |fetch-x-video |nginx-preview-http2$)/u.test(command)){
        maintenanceRequest(command);
        return {name:'owner_maintenance',params:{query:command}};
    }
    if(typeof command==='string' && command.startsWith('mkdir -p '+ownerImageDirectory)){
        parseImageExport(command);
        return {name:'owner_save_images',params:{query:command}};
    }
    if(typeof command==='string' && (command==='uptime' || /^(?:crop-gray|ps|docker|ls|grep|tail|cat|sed|free|df|nginx|systemctl|find|which|ss|file|stat|journalctl|git|echo) /u.test(command))){
        inspectionPlan(command);
        return {name:'owner_inspect',params:{query:command}};
    }
    if(typeof command!=='string'||command.length>4000||!command.startsWith(script+' ')||/[\r\n;|`<>]|\$\(/u.test(command))
        throw Error('该命令不属于已接入的固定业务命令');
    const args=command.slice(script.length+1).trim();
    if(args==='image-probe')return {name:'agy_image_probe',params:{}};
    if(['status','credentials','models'].includes(args))return {name:'agy_diagnostic',params:{action:args}};
    if(args==='quota'||args==='refresh')return {name:args==='quota'?'quota_query':'quota_refresh',params:{}};
    const single=/^image-generate\s+(?:'([^']+)'|"([^"$\\]+)")$/u.exec(args);
    if(single)return {name:'onebot_image_generate',params:{prompt:single[1]??single[2]}};
    const reference=/^official-image-generate\s+(?:'([^']+)'|"([^"$\\]+)")\s+(?:'([^']+)'|"([^"$\\]+)")$/u.exec(args);
    if(reference){
        const character=reference[1]??reference[2];
        if(!character.includes('，'))return {name:'image_reference',params:{character,prompt:reference[3]??reference[4]}};
    }
    throw Error('该命令不符合已登记业务工具的参数与原审批规则');
}

export function processGrants(tools){
    return tools.list(['quota_query','quota_refresh','onebot_image_generate','image_reference','agy_image_probe','agy_diagnostic','owner_inspect','owner_save_images','owner_maintenance']).map(tool=>tool.name);
}

function integer(value,min,max){
    if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('无效的等待时间');
    return value;
}
const query='SELECT p.operation_id,p.created,p.phase,o.state,o.kind,o.result FROM admin_processes p JOIN operations o ON p.operation_id=o.id WHERE p.owner=?';

function describe(row,withOutput){
    const {operation_id:sessionId,kind:name,state}=row;
    const status=state==='succeeded'?'completed':state==='uncertain'?'uncertain':
        state==='running'?(['started','approved'].includes(row.phase)?'running':'uncertain'):
        ['reviewing','waiting_approval'].includes(state)?state:
        state==='pending'&&row.phase==='started'?'running':'failed';
    const data={sessionId,name,status,startedAt:row.created};
    if(withOutput && state==='pending' && row.phase!=='started'){
        data.output=({blocked:'原工具检查未放行，未启动业务操作。',cancelled:'启动前已取消。',interrupted:'服务在启动过程中中断，未取得执行回执。'})[row.phase]??'业务操作未取得执行回执。';
    }
    if(withOutput && row.result && ['completed','uncertain','failed'].includes(status)){
        const result=JSON.parse(row.result);
        data.output=String(result.output??result.error??result.reason??'').slice(0,40000);
    }
    return data;
}

export function recoverAdminProcesses(store=operationStore()){
    return store.db.prepare("UPDATE admin_processes SET phase='interrupted' WHERE phase IN ('started','approved')").run().changes;
}
export function cancelAdminProcesses(sessionKey){
    const affected=[...active.values()].filter(job=>sessionKey===undefined||job.sessionKey===sessionKey);
    for(const job of affected)job.controller.abort();
    return [...affected,...cancelApprovedOwnerProcesses(sessionKey)];
}

export async function pollAdminProcess({action,sessionId,timeout=0},identity,signal,store=operationStore(),permitted){
    signal.throwIfAborted();
    const owner=ownerKey(identity);
    if(action==='list'){
        if(sessionId!==undefined||timeout!==0)throw Error('list 不接受句柄或等待时间');
        const allowed=permitted?.();
        if(allowed?.length===0)return {sessions:[]};
        const condition=allowed?' AND o.kind IN ('+allowed.map(()=>'?').join(',')+')':'';
        const rows=store.db.prepare(query+condition+' ORDER BY p.created DESC,p.operation_id LIMIT 100').all(owner,...(allowed??[]));
        return {sessions:rows.map(row=>describe(row,false))};
    }
    if(action!=='poll'||typeof sessionId!=='string'||!/^[a-f0-9]{64}$/u.test(sessionId))throw Error('无效的进程查询');
    const end=Date.now()+integer(timeout,0,2147483647);
    const read=store.db.prepare(query+' AND p.operation_id=?');
    for(;;){
        signal.throwIfAborted();
        const row=read.get(owner,sessionId);
        if(!row || permitted && !permitted().includes(row.kind))throw Error('当前会话没有此进程');
        const result=describe(row,true),left=end-Date.now();
        if(result.status!=='running'||left<=0)return result;
        await delay(Math.min(left,200),undefined,{signal});
    }
}

export async function startAdminProcess(params,identity,tools,signal,{store=operationStore()}={}){
    if(params.background!==undefined&&typeof params.background!=='boolean')throw Error('无效的后台运行标志');
    const yieldMs=integer(params.yieldMs??10000,0,2147483647);
    const {name,params:arguments_}=registeredCommand(params.command);
    if(!tools || !processGrants(tools).includes(name))throw Error('本轮未获对应业务工具授权');
    const {actor,sessionKey}=identity,owner=ownerKey(identity);
    if(!actor.requestId)throw Error('缺少原始 QQ 消息标识');
    const callId=String(actor.requestId)+'-exec-'+digest([name,arguments_]).slice(0,16);
    const timeout=params.timeout===undefined?undefined:integer(params.timeout,1,2147483)*1000;
    signal.throwIfAborted();
    const {operation,specification}=prepareBusinessTool(name,arguments_,actor,callId,sessionKey,store);
    const id=operation.id;
    const timeoutMs=Math.min(timeout??specification.timeoutMs,specification.timeoutMs);
    const inserted=store.db.prepare("INSERT OR IGNORE INTO admin_processes(operation_id,owner,phase,created,timeout_ms) VALUES(?,?,'started',?,?)").run(id,owner,Date.now(),timeoutMs).changes;
    let cancelWaiting;
    if(inserted){
        const controller=new AbortController(),deadline=AbortSignal.timeout(timeoutMs);
        const signals=[controller.signal,deadline];
        cancelWaiting=()=>controller.abort(signal.reason);
        signal.addEventListener('abort',cancelWaiting,{once:true});
        const job={sessionKey,controller};
        active.set(id,job);
        // Returning a process handle releases only this poll. The job retains its
        // own deadline and is cancelled by session reset, user abort or shutdown.
        job.done=(async()=>{
            const jobSignal=AbortSignal.any(signals);
            let phase='settled';
            try{
                const result=await tools.call(name,arguments_,callId,jobSignal,{ownedProcess:true});
                if(result?.isError)phase='blocked';
            }catch{phase=jobSignal.aborted?'cancelled':'blocked';}
            finally{
                store.db.prepare('UPDATE admin_processes SET phase=? WHERE operation_id=? AND phase=\'started\'').run(phase,id);
                active.delete(id);
            }
        })();
    }
    try{
        return await pollAdminProcess({action:'poll',sessionId:id,timeout:params.background?0:yieldMs},identity,signal,store,()=>processGrants(tools));
    }finally{if(cancelWaiting)signal.removeEventListener('abort',cancelWaiting);}
}
