#!/usr/bin/env node
import {inEmptyWorkspace,startCli} from '../src/src/ai/antigravity-process.js';
import {isUsageRow,refreshPersonalLogin} from '../src/src/ai/antigravity-login.js';

const action=process.argv[2];
const modelRow=/^([a-z0-9][a-z0-9_.-]{1,120})\t[^\t\r\n]+$/u;

async function rows(cwd,args,parse,signal){
    const result=[];
    const cli=startCli(args,{cwd,signal,timeoutMs:70000,onLine(line){
        const value=parse(line);
        if(value){
            if(result.length>=256)throw Error('Unexpected subscription diagnostic response');
            result.push(value);
        }
    }});
    cli.end();await cli.done;
    if(!result.length)throw Error('No recognized subscription diagnostic rows');
    return result;
}

if(process.argv.length!==3||!['quota','refresh','status','credentials','all'].includes(action))process.exitCode=2;
else {
    const cancel=new AbortController(),stop=()=>cancel.abort();
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    try{
        await inEmptyWorkspace(async cwd=>{
            // A valid quota response verifies the isolated CLI can use the login without inspecting its tokens.
            const refreshed=action==='refresh'?await refreshPersonalLogin(cancel.signal):undefined;
            const quotas=refreshed??await rows(cwd,['--print','/usage'],line=>isUsageRow(line)?line:undefined,cancel.signal);
            if(action==='quota'||action==='refresh'){process.stdout.write(quotas.join('\n')+'\n');return;}
            console.log('provider=antigravity-cli\npersonal_login=available');
            if(action==='credentials')return;
            const models=await rows(cwd,['models'],line=>modelRow.exec(line)?.[1],cancel.signal);
            console.log('native_model_count='+models.length);
            if(action==='all')console.log([...models.map(id=>'native_model='+id),...quotas].join('\n'));
        });
    }catch{process.stderr.write('Subscription diagnostic unavailable\n');process.exitCode=1;}
    finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
