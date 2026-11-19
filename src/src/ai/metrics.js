import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {onebotPath} from '../paths.js';

const turns=new AsyncLocalStorage();
const requests=new AsyncLocalStorage();
const digest=value=>createHash('sha256').update(String(value)).digest('hex');
const folder=()=>onebotPath('state','antigravity','metrics');
let directoryReady=false, reportedError=false;

// Write only operating metadata supplied by these instrumentation sites. Never
// include message bodies, tool arguments, exception messages or credentials.
export function metric(event,fields={}){
    if(process.env.ONEBOT_STANDALONE!=='1')return;
    try{
        const at=Date.now(),turn=turns.getStore();
        const inherited=process.env.ONEBOT_METRICS_TURN;
        const key=turn?.key??(/^[a-f0-9]{64}$/u.test(inherited??'')?inherited:undefined);
        if(!directoryReady){mkdirSync(folder(),{recursive:true,mode:0o700});directoryReady=true;}
        const record={at,event,turn:key,...requests.getStore(),...fields};
        appendFileSync(join(folder(),new Date(at).toISOString().slice(0,10)+'.jsonl'),JSON.stringify(record)+'\n',{mode:0o600});
        reportedError=false;
    }catch{
        if(!reportedError)console.warn('[onebot] Unable to persist model timing metrics');
        reportedError=true;
    }
}

export function metricsEnvironment(){
    const key=turns.getStore()?.key;
    return key?{ONEBOT_METRICS_TURN:key}:{};
}

export function withMetricRequest(id,taskId,work){
    if(process.env.ONEBOT_STANDALONE!=='1')return work();
    return requests.run({request:digest(id),taskId},work);
}

export function withMetricKey(key,work){
    return typeof key==='string'&&/^[a-f0-9]{64}$/u.test(key)?turns.run({key},work):work();
}

export function bindTurnMetrics(handler){
    const turn=turns.getStore();
    return turn?(...args)=>turns.run(turn,handler,...args):handler;
}

export async function withMeasuredTurn({identity,account,kind,receivedAt=Date.now(),hasImage=false},work){
    if(process.env.ONEBOT_STANDALONE!=='1'||turns.getStore())return work();
    const key=digest(JSON.stringify(identity));
    return turns.run({key},async()=>{
        const span=randomUUID();
        metric('start',{span,account,kind,receivedAt,hasImage});
        try{return await work();}finally{metric('end',{span});}
    });
}

export function measurePlatformReceipt(account,messageId,deliveryId){
    if(messageId!=null)metric('receipt',{account,platform:digest(messageId),deliveryId});
}

export function measureAttempt(step,context,requestId,event,actualModel){
    if(process.env.ONEBOT_STANDALONE!=='1')return;
    const safeName=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(value)?value:undefined;
    metric('attempt',{...event,request:digest(requestId),
        kind:safeName(event.kind),profile:safeName(context.aiProfile)??'normal',adapter:step.provider.adapter,
        provider:step.providerId,requestedModel:step.deployment.model,actualModel:safeName(actualModel)});
}
