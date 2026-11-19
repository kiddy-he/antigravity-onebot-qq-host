import {runScheduledCommand} from './scheduled-command.js';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {trustedServiceContext} from '../access/services.js';
import {resolveScheduledDestination} from '../destination-context.js';
import {onebotPlugin} from '../channel.js';
import {withOneBotCronRun,withOneBotCronDelivery,prepareOneBotCronBatch} from '../delivery/cron-lifecycle.js';
import {standaloneAgent} from './agent.js';

export async function executeOccurrence({job,slot,id},cfg,schedules,hooks,signal){
    const payload=job.payload;
    if(payload.kind==='command')return runScheduledCommand(job,signal);
    const defaults=cfg.agents?.defaults?.timeoutSeconds??172800;
    const seconds=Number.isFinite(payload.timeoutSeconds)&&payload.timeoutSeconds>=0?payload.timeoutSeconds:defaults;
    const timeoutMs=seconds===0?2147483647:Math.min(2147483647,Math.max(1,Math.floor(seconds))*1000);
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]);
    const agentId=job.agentId??'main';
    if(payload.kind==='heartbeat'){
        const workspace=cfg.agents.entries?.[agentId]?.workspace??cfg.agents.defaults.workspace;
        const path=join(workspace.replace(/^~\//u,homedir()+'/'),'HEARTBEAT.md');
        let content='';
        try{content=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
        if(content.split('\n').every(line=>!line.trim() || /^\s*#/u.test(line)))return {status:'ok',reason:'empty-heartbeat'};
        await standaloneAgent({cfg,sessionKey:'agent:'+agentId+':main',agentId,text:content,requestId:id,toolsAllow:[],signal:bounded,timeoutMs});
        return {status:'ok'};
    }
    if(payload.kind!=='agentTurn')throw Error('Unsupported cron payload');
    const sessionKey='agent:'+agentId+':cron:'+job.id+':run:'+id;
    if(!trustedServiceContext(sessionKey))throw Error('Service identity unavailable');
    const target=()=>resolveScheduledDestination(sessionKey,{readJob:jobId=>schedules.get(jobId)});
    if(!target())throw Error('Service destination unavailable');
    const scope={sessionKey,agentId,runId:id,accountId:job.delivery.accountId??'default',channelId:'onebot',config:cfg};
    return withOneBotCronRun({...job,state:{...job.state,nextRunAtMs:slot}},async()=>{
        try{
            const ctx=await hooks('before_prompt_build',{prompt:payload.message,messages:[]},scope);
            const prompt=[...ctx.map(r=>r.prependContext),payload.message,...ctx.map(r=>r.appendContext)].filter(Boolean).join('\n\n');
            const result=await standaloneAgent({cfg,sessionKey,agentId,requestId:id,text:prompt,signal:bounded,timeoutMs,
                thinking:payload.thinking,toolsAllow:payload.toolsAllow,stableInstructions:ctx.flatMap(r=>[r.prependSystemContext,r.appendSystemContext]).filter(Boolean).join('\n\n')});
            bounded.throwIfAborted();
            if(!target())throw Error('Service destination revoked');
            const event={to:job.delivery.to,content:result.text};
            await hooks('message_sending',event,scope);
            if(!event.content.trim() || event.cancel)throw Error('Service delivery blocked');
            await withOneBotCronDelivery({job,abortSignal:bounded},async()=>{
                prepareOneBotCronBatch(1);
                const receipt=await onebotPlugin.outbound.sendText({to:event.to,text:event.content,accountId:scope.accountId,cfg,signal:bounded});
                await hooks('message_sent',{...event,success:true,messageId:receipt.messageId},scope);
            });
            return {status:'ok',modelInfo:{provider:result.providerId,model:result.nativeModel??result.model,
                ...(result.effort?{thinking:result.effort}:{})}};
        }finally{await hooks('agent_end',{},scope);}
    });
}

export function cronCommand(args,schedules,{run}){
    const [action,id]=args;
    const opt=key=>args.includes(key)?args[args.indexOf(key)+1]:undefined;
    if(action==='list')return {jobs:schedules.list().filter(j=>args.includes('--all')||j.enabled)};
    if(action==='runs'){
        const rows=schedules.db.prepare('SELECT status,slot,detail,summary,model_info FROM occurrences WHERE job=? ORDER BY slot DESC LIMIT ?')
            .all(opt('--id'),Math.min(100,Number(opt('--limit')??10)));
        return {entries:rows.map(r=>({action:r.status==='started'?'started':'finished',status:r.status==='completed'?'ok':r.status,ts:r.slot,error:r.detail||undefined,summary:r.summary??undefined,...JSON.parse(r.model_info??'{}')}))};
    }
    if(action==='run')return run(id);
    if(action==='rm')return {removed:!!schedules.remove(id)};
    const job=action==='add'?{id:randomUUID(),enabled:!args.includes('--disabled'),createdAtMs:Date.now(),wakeMode:'now',sessionTarget:'isolated',state:{}}:schedules.get(id);
    if(!job)throw Error('Unknown job');
    if(['enable','disable'].includes(action))job.enabled=action==='enable';
    else if(['edit','add'].includes(action)){
        if(opt('--declaration-key')){
            const existing=schedules.list().find(j=>j.declarationKey===opt('--declaration-key'));
            if(existing&&action==='add')return existing;
            job.declarationKey=opt('--declaration-key');
        }
        if(opt('--name'))job.name=opt('--name');
        if(opt('--agent'))job.agentId=opt('--agent');
        if(opt('--at'))job.schedule={kind:'at',at:opt('--at')};
        if(opt('--cron'))job.schedule={kind:'cron',expr:opt('--cron'),tz:opt('--tz')};
        if(args.includes('--delete-after-run'))job.deleteAfterRun=true;
        if(opt('--session'))job.sessionTarget=opt('--session');
        if(opt('--message'))job.payload={...job.payload,kind:'agentTurn',message:opt('--message')};
        if(opt('--command-argv'))job.payload={...job.payload,kind:'command',argv:JSON.parse(opt('--command-argv'))};
        if(!job.payload)throw Error('Missing payload');
        if(opt('--thinking')!==undefined){
            const thinking=opt('--thinking');
            if(job.payload.kind!=='agentTurn' || !['off','minimal','low','medium','high','xhigh','adaptive','max'].includes(thinking))throw Error('Invalid agent thinking level');
            job.payload.thinking=thinking;
        }
        for(const [flag,field] of [['--timeout-seconds','timeoutSeconds'],['--no-output-timeout-seconds','noOutputTimeoutSeconds'],['--output-max-bytes','outputMaxBytes']]){
            if(opt(flag)!==undefined)job.payload[field]=Number(opt(flag));
        }
        if(opt('--command-cwd'))job.payload.cwd=opt('--command-cwd');
        if(args.includes('--tools'))job.payload.toolsAllow=opt('--tools').split(',').filter(Boolean);
        if(args.includes('--announce'))job.delivery={mode:'announce',channel:opt('--channel'),accountId:opt('--account')??'default',to:opt('--to')};
        if(args.includes('--no-deliver'))job.delivery={mode:'none'};
    }else throw Error('Unsupported scheduler action');
    schedules.put(job);
    return job;
}
