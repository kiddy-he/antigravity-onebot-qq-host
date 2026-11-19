import http from 'node:http';
import {withMeasuredTurn} from '../ai/metrics.js';
import {mkdir,chmod,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {onebotPath} from '../paths.js';
import {setOneBotRuntime,clearOneBotRuntime} from '../runtime.js';
import {listOneBotAccountIds,resolveOneBotAccount} from '../config.js';
import {startGateway} from '../gateway.js';
import {standaloneChannel} from './channel-runtime.js';
import {Schedules} from './schedules.js';
import {readConfig,dispatchLocalCommand} from './commands.js';
import {cronCommand,executeOccurrence} from './cron.js';
import {cancelAdminProcesses,recoverAdminProcesses} from './admin-process.js';
import {registerPersonalLoginService} from '../ai/antigravity-login.js';
import {loadAiConfig} from '../ai/config.js';
import {loadAppConfig} from '../app-config.js';
import {registerConversationResetHooks} from '../conversation-reset.js';
import {registerConversationTranscriptHooks} from '../conversation-transcript.js';
import {registerScheduledConversationContext,resolveScheduledDestination} from '../destination-context.js';
import {registerFeatureOutboundGuard} from '../feature-tools.js';
import {registerServiceSpeechHooks} from '../features/speech-hooks.js';
import {registerReminderService} from '../features/reminders.js';
import {registerDeliveryRecovery,deliveryQueue} from '../delivery/queue.js';
import {reconcileHostDeliveries} from './delivery-handoff.js';
import {registerBilibiliWebhook} from '../features/bilibili.js';
import {registerScriptDelivery} from '../delivery/ingress.js';
import {startXhsService,stopXhsService} from '../features/xhs.js';

const listen=(server,...args)=>new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(...args,()=>{server.removeListener('error',reject);resolve();});
});
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});
export async function serve({signal,log=console}){
    const cfg=await readConfig();
    const accounts=listOneBotAccountIds(cfg).map(id=>resolveOneBotAccount(cfg,id)).filter(a=>a.enabled);
    if(!accounts.length)throw Error('No active OneBot accounts');
    const ai=loadAiConfig();
    if(!ai.providers['antigravity-cli'] || Object.values(ai.providers).some(p=>p.adapter!=='antigravity-cli' &&
        /^(?:https?:\/\/)(?:127\.0\.0\.1|localhost):8045(?:\/|$)/iu.test(p.baseUrl??'')))
        throw Error('Standalone service requires migrated subscription routes');
    const stop=new AbortController(),cancel=AbortSignal.any([signal,stop.signal]);
    cancel.throwIfAborted();
    const routes=new Map(),handlers=new Map(),services=[],started=[],channels=[],inflight=new Set();
    let schedules,clock,admin,ready=false;
    const api={config:cfg,logger:log,
        on(event,fn,{priority=0}={}){const bucket=handlers.get(event)??[];bucket.push({fn,priority});handlers.set(event,bucket.sort((a,b)=>b.priority-a.priority));},
        registerService(service){services.push(service);},
        registerHttpRoute(route){if(routes.has(route.path))throw Error('Duplicate HTTP route');routes.set(route.path,route);}
    };
    async function hooks(name,event,ctx){
        const results=[];
        for(const {fn} of handlers.get(name)??[]){
            const result=await fn(event,ctx);
            if(result){
                results.push(result);
                if(name==='message_sending' && result.content!==undefined)event.content=result.content;
                if(result.cancel){event.cancel=true;break;}
            }
        }
        return results;
    }
    const options={placement:loadAppConfig().historyContextPlacement};
    registerPersonalLoginService(api,cancel);
    registerConversationResetHooks(api);
    registerConversationTranscriptHooks(api,options);
    registerScheduledConversationContext(api,{...options,resolve:key=>resolveScheduledDestination(key,{readJob:id=>schedules.get(id)})});
    registerFeatureOutboundGuard(api);registerServiceSpeechHooks(api,options);
    registerDeliveryRecovery(api);registerReminderService(api);
    api.registerService({start:startXhsService,stop:stopXhsService});
    registerBilibiliWebhook(api);registerScriptDelivery(api);
    const httpServer=http.createServer(async(req,res)=>{
        try{
            const route=routes.get(req.url?.split('?')[0]);
            if(!route){res.writeHead(404);res.end();return;}
            if(!ready){res.writeHead(503,{'Retry-After':'2'});res.end();return;}
            await route.handler(req,res);
        }catch{if(!res.headersSent)res.writeHead(500);res.end();}
    });
    // Reserve the legacy gateway port before any recovery, scheduling, or WS subscription.
    await listen(httpServer,cfg.gateway?.port??18789,'127.0.0.1');
    const socket=onebotPath('state','standalone','control.sock');
    const execute=async occurrence=>{
        if(!occurrence)throw Error('Job unavailable or already running');
        let status='failed',detail='',summary,modelInfo;
        try{
            const outcome=await withMeasuredTurn({identity:['schedule',occurrence.id],
                account:occurrence.job.delivery?.accountId,kind:occurrence.job.payload.kind,receivedAt:occurrence.slot},
                ()=>executeOccurrence(occurrence,cfg,schedules,hooks,cancel));
            status=outcome.onebotDeliveryUncertain?'uncertain':outcome.status==='ok'?'completed':'failed';
            detail=outcome.error??'';
            summary=outcome.summary;modelInfo=outcome.modelInfo;
            return {ok:status==='completed',status};
        }catch(error){detail=error.message;throw error;}
        finally{schedules.finish(occurrence,status,detail,summary,modelInfo);}
    };
    function track(occurrence){
        const promise=execute(occurrence);inflight.add(promise);
        promise.then(()=>inflight.delete(promise),()=>inflight.delete(promise));
        return promise;
    }
    try {
        const dir=onebotPath('state','standalone');await mkdir(dir,{recursive:true,mode:0o700});
        schedules=new Schedules(onebotPath('state','standalone','schedules.sqlite'));
        const legacy=onebotPath('state','openclaw.sqlite');
        if(existsSync(legacy)){
            const snapshot=schedules.pendingHostImport(legacy,cfg.cron?.store);
            const stats=reconcileHostDeliveries(legacy,deliveryQueue());
            log.info('OneBot delivery handoff '+JSON.stringify(stats));
            schedules.importSnapshot(snapshot);
        }
        schedules.recover();recoverAdminProcesses();
        setOneBotRuntime(standaloneChannel(hooks,log));
        for(const service of services){started.push(service);await service.start();}
        ready=true;
        for(const account of accounts){
            channels.push(startGateway({account,cfg,abortSignal:cancel,log,
                onReady:()=>log.info('OneBot connected '+account.accountId)}).catch(error=>{stop.abort(error);}));
        }
        await unlink(socket).catch(error=>{if(error.code!=='ENOENT')throw error;});
        admin=http.createServer(async(req,res)=>{
            try{
                if(req.method!=='POST'||req.url!=='/command')throw Error('Unsupported control request');
                const chunks=[];let bytes=0;
                for await(const chunk of req){bytes+=chunk.length;if(bytes>131072)throw Error('Request too large');chunks.push(chunk);}
                const args=JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if(!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw Error('Invalid control request');
                let result;
                if(args[0]==='cron')result=await cronCommand(args.slice(1),schedules,{run:id=>track(schedules.claim(Date.now(),id))});
                else if(args[0]==='gateway' && args[1]==='call' && args[2]==='cron.update'){
                    const {id,patch}=JSON.parse(args[args.indexOf('--params')+1]);
                    const job=schedules.get(id),payload=patch?.payload;
                    if(job?.payload?.kind!=='agentTurn'||payload?.kind!=='agentTurn'||!Array.isArray(payload.toolsAllow)||
                        !payload.toolsAllow.every(name=>typeof name==='string')||
                        Object.keys(payload).some(k=>!['kind','toolsAllow'].includes(k))||Object.keys(patch).length!==1)
                        throw Error('Unsupported scheduler update');
                    job.payload.toolsAllow=payload.toolsAllow;schedules.put(job);result=job;
                }else if(args[0]==='gateway' && args[1]==='call' && ['sessions.delete','sessions.reset','sessions.abort'].includes(args[2])){
                    const {key}=JSON.parse(args[args.indexOf('--params')+1]);
                    if(args[2]!=='sessions.abort')await hooks('before_reset',{}, {sessionKey:key});
                    result=JSON.parse((await dispatchLocalCommand(args)).stdout);
                }else throw Error('Unsupported administrative operation');
                res.end(JSON.stringify(result));
            }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error.message}));}
        });
        await listen(admin,socket);await chmod(socket,0o600);
        if(cfg.cron?.enabled!==false && process.env.OPENCLAW_SKIP_CRON!=='1')clock=setInterval(()=>{
            if(cancel.aborted || inflight.size>=4)return;
            try{const occurrence=schedules.claim();if(occurrence)track(occurrence).catch(e=>log.error('Cron '+occurrence.job.id+': '+e.message));}
            catch(error){log.error('Scheduler: '+error.message);}
        },500);
        if(!cancel.aborted)await new Promise(resolve=>cancel.addEventListener('abort',resolve,{once:true}));
        if(stop.signal.aborted)throw stop.signal.reason;
    }finally{
        ready=false;
        clearInterval(clock);stop.abort();
        if(admin)await close(admin);
        await Promise.allSettled(channels);
        await Promise.allSettled(inflight);
        await Promise.allSettled(cancelAdminProcesses().map(job=>job.done));
        for(const service of started.reverse()) await service.stop?.();
        clearOneBotRuntime();schedules?.close();await close(httpServer);
    }
}
