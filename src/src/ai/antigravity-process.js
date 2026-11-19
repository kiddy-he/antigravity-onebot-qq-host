import {isolatedCommand} from './antigravity-isolation.js';
import {metric} from './metrics.js';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {AiError} from './router.js';

// The CLI resolves its own personal login. Project API keys and arbitrary
// provider overrides from the hosting agent must never reach this subprocess.
export function personalEnvironment(source = process.env) {
    const keys = ['HOME','PATH','USER','LOGNAME','LANG','LC_ALL','TMPDIR','XDG_RUNTIME_DIR',
        'DBUS_SESSION_BUS_ADDRESS','SSL_CERT_FILE','SSL_CERT_DIR','HTTPS_PROXY','HTTP_PROXY',
        'NO_PROXY','ALL_PROXY','https_proxy','http_proxy','no_proxy','all_proxy'];
    return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key,source[key]]));
}

export function cliFailure(detail) {
    const text = String(detail);
    const rules = [
        ['authentication_error', /authentication required|unauthenticated|login required|not logged in|sign in|invalid_grant|\b401\b/i],
        ['authorization_denied', /permission denied|forbidden|\b403\b/i],
        ['rate_limited', /quota|rate.limit|resource.exhausted|\b429\b/i],
        ['model_unavailable', /unknown model|unavailable model|model .*not (?:available|found)|invalid model/i],
        ['timeout', /timed? ?out|deadline exceeded/i],
        ['cancelled', /cancelled|canceled/i],
        ['configuration_error', /ENOENT|EACCES|not executable/i],
        ['upstream_5xx', /\b50[0234]\b|internal server error/i],
    ];
    return new AiError(rules.find(([,pattern]) => pattern.test(text))?.[0] ?? 'network_error',
        'Antigravity CLI request failed');
}

export async function inEmptyWorkspace(fn) {
    const cwd = await mkdtemp(join(tmpdir(),'onebot-agy-'));
    try { return await fn(cwd); }
    finally { await rm(cwd,{force:true,recursive:true}); }
}

// Each child has its own process group. Deadlines include stream processing;
// the abort path also kills workers which have inherited stdout or stdin.
export function startCli(args,{cwd, signal, timeoutMs=90000, executable, mcp, onLine, onAbort}) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(Math.max(1,Math.ceil(timeoutMs)));
    const bounded = signal ? AbortSignal.any([signal,deadline]) : deadline;
    const launch=isolatedCommand(args,{cwd,executable,mcp});
    let child;
    try {child=spawn(launch.file,launch.args,{cwd,env:personalEnvironment(),stdio:['pipe','pipe','pipe',launch.fd],detached:true});}
    finally {launch.close();}
    child.once('spawn',()=>metric('cli-start',{interface:args.includes('acp')?'acp':'headless'}));
    const decoder = new StringDecoder('utf8');
    let partial='', diagnostics='', failure, closed=false, abortTimer;
    let resolveDone, rejectDone;
    const done = new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
    // ACP can fail while its caller is between protocol requests.
    done.catch(()=>{});
    function kill() {
        if (child.pid && !closed) {
            try { process.kill(-child.pid,'SIGKILL'); } catch (error) { if(error.code!=='ESRCH') child.kill('SIGKILL'); }
        }
    }
    function fail(error) { failure ??= error; kill(); }
    function abort() {
        failure??=new AiError(bounded.reason?.name==='TimeoutError'?'timeout':'cancelled');
        if(onAbort && !closed && child.stdin.writable) {
            try {
                const message=onAbort();
                if(message){child.stdin.write(JSON.stringify(message)+'\n');abortTimer=setTimeout(kill,250);return;}
            } catch { /* The process may have closed its input. */ }
        }
        kill();
    }
    child.stdin.on('error',error=>{ if(error.code!=='EPIPE') fail(cliFailure(error)); });
    child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-8192);});
    function line(value) {
        if (Buffer.byteLength(value)>8*1024*1024) throw new AiError('incomplete_output','Oversized CLI event');
        if (value.trim()) onLine(value);
    }
    child.stdout.on('data',chunk=>{
        if(failure) return;
        try {
            partial+=decoder.write(chunk);
            let boundary;
            while((boundary=partial.indexOf('\n'))>=0) {
                const value=partial.slice(0,boundary); partial=partial.slice(boundary+1); line(value);
            }
            if(Buffer.byteLength(partial)>8*1024*1024) throw new AiError('incomplete_output','Oversized CLI event');
        } catch(error) { fail(error instanceof AiError?error:new AiError('invalid_schema','Invalid CLI stream')); }
    });
    child.on('error',error=>{failure??=cliFailure(error);});
    child.on('close',code=>{
        closed=true; clearTimeout(abortTimer); bounded.removeEventListener('abort',abort);
        try { if(!failure) line(partial+decoder.end()); } catch(error){failure=error;}
        if(failure || code!==0) rejectDone(failure??cliFailure(diagnostics));
        else resolveDone();
    });
    bounded.addEventListener('abort',abort,{once:true});
    if (bounded.aborted) abort();
    return {send:value=>child.stdin.write(JSON.stringify(value)+'\n'), end:()=>child.stdin.end(), kill, done};
}
