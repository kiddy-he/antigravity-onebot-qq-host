import {spawn} from 'node:child_process';
import {metricsEnvironment} from '../ai/metrics.js';
import {realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const wrapper=fileURLToPath(new URL('../../../scripts/run-scheduled.mjs',import.meta.url));
const maxTimer=2147483647;

function milliseconds(seconds,fallback){
    if(!Number.isFinite(seconds))return fallback;
    return seconds<=0?maxTimer:Math.min(maxTimer,Math.max(1,Math.round(seconds*1000)));
}

function outputTail(limit){
    const chunks=[];
    let size=0;
    return {
        append(chunk){
            chunks.push(chunk);size+=chunk.length;
            while(size>limit){
                const remove=Math.min(chunks[0].length,size-limit);
                if(remove===chunks[0].length)chunks.shift();
                else chunks[0]=chunks[0].subarray(remove);
                size-=remove;
            }
        },
        text(){return Buffer.concat(chunks,size).toString('utf8').trim();}
    };
}

export async function runScheduledCommand(job,signal){
    const {payload}=job;
    if(payload.kind!=='command'||payload.argv?.length!==3||payload.argv[1]!==wrapper||payload.argv[2]!==job.id||
        !/^[0-9a-f-]{36}$/u.test(job.id)||await realpath(payload.argv[0])!==await realpath(process.execPath))
        throw Error('Command job lacks its registered fixed wrapper');
    const total=milliseconds(payload.timeoutSeconds,600000);
    const idle=milliseconds(payload.noOutputTimeoutSeconds);
    const limit=Number.isSafeInteger(payload.outputMaxBytes)&&payload.outputMaxBytes>0?payload.outputMaxBytes:16*1024*1024;
    const stdout=outputTail(limit),stderr=outputTail(limit);
    signal.throwIfAborted();
    // The wrapper resolves the service grant and fixed inner argv again at execution time.
    const child=spawn(process.execPath,[wrapper,job.id],{cwd:payload.cwd,detached:true,stdio:['ignore','pipe','pipe'],
        env:{...process.env,...metricsEnvironment()}});
    let idleTimer,deadline,drainTimer,forceTimer,stopping,force;
    function killGroup(sig){
        if(!child.pid)return;
        try{process.kill(-child.pid,sig);}catch(error){if(error.code!=='ESRCH')throw error;}
    }
    function stop(reason){
        if(stopping)return;
        stopping=reason;
        killGroup('SIGTERM');
        force=new Promise(resolve=>{
            forceTimer=setTimeout(()=>{
                killGroup('SIGKILL');
                child.stdout.destroy();child.stderr.destroy();
                resolve();
            },300);
        });
    }
    const abort=()=>stop('command cancelled');
    signal.addEventListener('abort',abort,{once:true});
    function resetIdle(){
        if(!idle||stopping||drainTimer)return;
        if(idleTimer)idleTimer.refresh();
        else idleTimer=setTimeout(()=>stop('command produced no output before noOutputTimeoutSeconds'),idle);
    }
    try{
        const closed=new Promise((resolve,reject)=>{
            child.once('error',reject);
            child.once('close',(code,sig)=>resolve({code,sig}));
        });
        for(const [stream,tail] of [[child.stdout,stdout],[child.stderr,stderr]])
            stream.on('data',chunk=>{tail.append(chunk);resetIdle();});
        child.once('exit',()=>{
            clearTimeout(deadline);clearTimeout(idleTimer);
            drainTimer=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();},1000);
        });
        deadline=setTimeout(()=>stop('command timed out'),total);
        resetIdle();
        const {code,sig}=await closed;
        // A descendant can close the pipes or the wrapper can exit before siblings consume SIGTERM.
        if(force)await force;
        const out=stdout.text(),err=stderr.text();
        const summary=out&&err?'stdout:\n'+out+'\n\nstderr:\n'+err:out||err||undefined;
        const error=stopping??(sig?'command stopped by signal '+sig:code!==0?'command exited with code '+code:undefined);
        return {status:error?'error':'ok',summary,error,...(signal.aborted?{onebotDeliveryUncertain:true}:{})};
    }finally{
        clearTimeout(deadline);clearTimeout(idleTimer);clearTimeout(drainTimer);clearTimeout(forceTimer);
        signal.removeEventListener('abort',abort);
    }
}
