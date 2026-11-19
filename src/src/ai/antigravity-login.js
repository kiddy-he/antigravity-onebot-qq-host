import {execFile} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {onebotPath} from '../paths.js';
import {loadAiConfig} from './config.js';
import {inEmptyWorkspace,personalEnvironment,cliFailure} from './antigravity-process.js';
import {sessionSettings} from './antigravity-acp.js';
const run=promisify(execFile);

export function isUsageRow(line){
    return /^[^\t\r\n]+\t[^\t\r\n]+\t\d+(?:\.\d+)?%\t[0-9TZ:+.-]+$/u.test(line);
}

// Only the fixed native /usage command runs with write access to the canonical
// login. User prompts and MCP clients always use isolated, read-only credentials.
export async function refreshPersonalLogin(signal){
    const profile=join(homedir(),'.gemini','antigravity-cli');
    // A supplied credential profile is externally managed. Never refresh a
    // different HOME's identity on its behalf.
    if(process.env.ONEBOT_AGY_PROFILE_DIR && process.env.ONEBOT_AGY_PROFILE_DIR!==profile)return;
    const dir=onebotPath('state','antigravity');
    await mkdir(dir,{mode:0o700,recursive:true});
    return inEmptyWorkspace(async cwd=>{
        const executable=process.env.ONEBOT_AGY_BIN??join(homedir(),'.local/bin/agy');
        try{
            const {stdout}=await run('/usr/bin/flock',['--no-fork','-w','5',join(dir,'personal-login.lock'),executable,
                '--settings',sessionSettings(),'--sandbox','--print','/usage'],
                {cwd,env:personalEnvironment(),timeout:45000,signal,killSignal:'SIGKILL',maxBuffer:65536});
            const quotas=stdout.split(/\r?\n/u).filter(isUsageRow);
            if(!quotas.length || quotas.length>256)throw Error('Authentication required');
            return quotas;
        }catch(error){throw cliFailure(error.stderr || error.message);}
    });
}

export function registerPersonalLoginService(api,hostSignal){
    let controller,timer,running;
    function refresh(signal,trigger){
        running??=refreshPersonalLogin(signal).then(rows=>{
            if(rows)api.logger?.info?.('Subscription login verified trigger='+trigger+' quotaWindows='+rows.length);
        }).catch(error=>{
            if(!signal.aborted)api.logger?.warn?.('Subscription login check: '+error.kind);
        }).finally(()=>{running=undefined;});
        return running;
    }
    api.registerService({
        id:'onebot-personal-login',
        async start(){
            if(controller)return running;
            if(loadAiConfig().providers['antigravity-cli']?.adapter!=='antigravity-cli')return;
            controller=new AbortController();
            const signal=hostSignal?AbortSignal.any([hostSignal,controller.signal]):controller.signal;
            await refresh(signal,'startup');
            if(!signal.aborted){
                timer=setInterval(()=>refresh(signal,'periodic'),30*60000);
                timer.unref();
            }
        },
        async stop(){
            clearInterval(timer);controller?.abort();await running;
            controller=undefined;
        }
    });
}
