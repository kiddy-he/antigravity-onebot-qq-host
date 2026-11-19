import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AiError} from './router.js';

const run=promisify(execFile);
const redirectPrefix='https://vertexaisearch.cloud.google.com/grounding-api-redirect/';
const links=text=>[...String(text).matchAll(/https?:\/\/[^\s<>"\\)\]\x60]+/gu)].map(m=>m[0]);

// agy 1.5.12 can omit rawOutput on the public ACP channel. In this case
// validate its quoted Google grounding IDs with the issuer, without opening
// destinations selected by the model or forwarding QQ text to the issuer.
async function resolveGroundingLink(candidate,signal) {
    if(!candidate.startsWith(redirectPrefix)) return;
    const id=candidate.slice(redirectPrefix.length);
    if(!/^[a-zA-Z0-9_=-]{20,4096}$/u.test(id)) return;
    try {
        const {stdout}=await run('/usr/bin/curl',['--disable','--silent','--show-error','--proto','=https',
            '--max-time','8','--max-redirs','0','--output','/dev/null','--write-out','%{http_code}\n%{redirect_url}',candidate],
            {signal,maxBuffer:12288,timeout:9000});
        const [status,location]=stdout.split('\n');
        if(!['301','302','303','307','308'].includes(status)) return;
        const url=new URL(location);
        if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password) return url.href;
    } catch(error) { if(signal?.aborted) throw signal.reason; }
}

export async function nativeSources(calls,answer,prompt,signal,verify=resolveGroundingLink) {
    const sources=new Set();
    let completed=false;
    for(const call of calls){
        if(call.status!=='completed'||call.name!=='search_web') continue;
        completed=true;
        for(const url of links(JSON.stringify([call.rawOutput,call.content?.map(x=>x.content??x.resource)]))) sources.add(url);
    }
    if(completed&&!sources.size){
        const quoted=new Set(prompt.filter(p=>p.type==='text').flatMap(p=>links(p.text)));
        const candidates=[...new Set(links(answer))].filter(link=>link.startsWith(redirectPrefix)&&!quoted.has(link)).slice(0,5);
        for(const url of await Promise.all(candidates.map(link=>verify(link,signal)))) if(url) sources.add(url);
    }
    if(!sources.size) throw new AiError('validation_failed','Native web search returned no verifiable sources');
    return [...sources];
}
