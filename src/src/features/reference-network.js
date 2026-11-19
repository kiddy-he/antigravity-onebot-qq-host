/** Bounded public reference retrieval. No AI provider or credential handling. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const execute=promisify(execFile);
const hosts={wikipedia:['zh.wikipedia.org','upload.wikimedia.org'],moegirl:['zh.moegirl.org.cn','storage.moegirl.org.cn','img.moegirl.org.cn'],baidu:['baike.baidu.com','wapbaike.baidu.com','bkimg.cdn.bcebos.com','bkimg.cdn.bcebos.com.cn','bkimg.bdimg.com']};
export function referenceNetworkSettings(config){
 const s=config?.workflows?.image?.referenceNetwork;
 if(!s||typeof s!=='object')throw Error('reference_network_configuration');
 for(const k of ['connectTimeoutMs','directTimeoutMs','proxyTimeoutMs','requestBudgetMs','sourceBudgetMs','characterBudgetMs','downloadBudgetMs','maxResponseBytes'])
  if(!Number.isSafeInteger(s[k])||s[k]<1||s[k]>(k==='maxResponseBytes'?16777216:600000))throw Error('reference_network_configuration');
 if(s.connectTimeoutMs>s.directTimeoutMs||s.requestBudgetMs<s.directTimeoutMs||s.sourceBudgetMs>s.characterBudgetMs)throw Error('reference_network_configuration');
 const proxy=new URL(s.proxyUrl);
 if(!['http:','https:','socks5h:'].includes(proxy.protocol)||proxy.username||proxy.password||proxy.pathname!=='/'||proxy.search||proxy.hash)throw Error('reference_network_configuration');
 if(!Array.isArray(s.sources)||!s.sources.length||new Set(s.sources).size!==s.sources.length||s.sources.some(x=>!hosts[x]))throw Error('reference_network_configuration');
 return s;
}
export function validReferenceUrl(value,source){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')
  &&(hosts[source]?hosts[source].includes(u.hostname):!['localhost','127.0.0.1','[::1]','0.0.0.0','169.254.169.254'].includes(u.hostname));}catch{return false;}
}
export function referenceResponseProblem(body,{source,status=200,contentType='',expectJson=false,expectImage=false}={}){
 const prefix=body.subarray(0,65536).toString('utf8');
 if(/<title[^>]*>\s*百度安全验证|<title[^>]*>\s*Security Verification|wappass\.baidu\.com\/static\/tangram/u.test(prefix))return 'challenge_required';
 if(status<200||status>=300)return 'search_network_error';
 if(expectImage&&!/^image\/(?:png|jpeg|webp)(?:;|$)/iu.test(contentType))return 'reference_image_unavailable';
 if(expectJson&&!/^(?:image\/)/iu.test(contentType)){
  try{const value=JSON.parse(body.toString('utf8'));if(!value||typeof value!=='object'||value.error)return 'search_invalid_response';}catch{return 'search_invalid_response';}
 }
 return null;
}
/** Remove competing curl routing/retry/time/output flags. Caller owns other fixed GET arguments. */
export function referenceCurlArguments(args){
 const kept=[];let output,url;
 const takesValue=new Set(['--max-time','--connect-timeout','--retry','--retry-delay','--retry-max-time','--proxy','--noproxy','--write-out','-w','--dump-header','-D','--max-redirs','--proto','--proto-redir','--max-filesize']);
 const boolean=new Set(['--location','-L','--retry-all-errors','--compressed','--http1.1','--fail','-f','--fail-with-body']);
 for(let i=0;i<args.length;i++){
  const a=args[i];
  if(['--output','-o'].includes(a)){output=args[++i];continue;}
  if(takesValue.has(a)){i++;continue;}if(boolean.has(a))continue;
  if(/^https:\/\//u.test(a)){if(url)throw Error('reference_arguments');url=a;continue;}
  kept.push(a);
 }
 if(!url)throw Error('reference_arguments');
 return {args:kept,output,url};
}
export async function fetchReference({source,args,settings,deadline=Infinity,stateFile,run=execute,now=Date.now,onEvent=()=>{},allowUrl=url=>validReferenceUrl(url,source)}){
 const parsed=referenceCurlArguments(args);
 if(![...Object.keys(hosts),'reference'].includes(source)||!validReferenceUrl(parsed.url,source)||!allowUrl(parsed.url))return {ok:false,reason:'reference_url_rejected'};
 const started=now(),end=Math.min(deadline,started+settings.requestBudgetMs);
 const dir=await mkdtemp(join(tmpdir(),'onebot-reference-http-'));
 const bodyFile=join(dir,'body'),headers=join(dir,'headers');let state={};
 try{
  try{if(stateFile)state=JSON.parse(await readFile(stateFile,'utf8'));}catch{}
  const key=new URL(parsed.url).hostname;
  // Once direct access fails in this character lookup, avoid paying its timeout
  // again for every query, gallery and image on the same source.
  const routes=state[key]==='proxy'?['proxy']:['direct','proxy'];
  let reason='search_network_error';
  for(const route of routes){
   const routeEnd=Math.min(end,now()+(route==='direct'?settings.directTimeoutMs:settings.proxyTimeoutMs));
   let url=parsed.url,queryArgs=parsed.args;
   for(let redirects=0;redirects<=3;redirects++){
    const remaining=routeEnd-now();if(remaining<100){reason='reference_timeout';break;}
    if(!validReferenceUrl(url,source)||!allowUrl(url)){reason='reference_url_rejected';break;}
    await rm(bodyFile,{force:true});await rm(headers,{force:true});
    const command=[...queryArgs,'--http1.1','--compressed','--silent','--show-error','--proto','=https','--retry','0',
     '--connect-timeout',String(Math.min(settings.connectTimeoutMs,remaining)/1000),'--max-time',String(remaining/1000),
     '--max-filesize',String(settings.maxResponseBytes),...(route==='direct'?['--noproxy','*']:['--noproxy','','--proxy',settings.proxyUrl]),
     '--output',bodyFile,'--dump-header',headers,'--write-out','%{json}',url];
    let response;
    try{response=await run('curl',command,{encoding:'utf8',timeout:Math.ceil(remaining)+500,maxBuffer:1024*1024});}
    catch{reason='search_network_error';break;}
    let meta;try{meta=JSON.parse(response.stdout);}catch{reason='search_invalid_response';break;}
    if(meta.http_code>=300&&meta.http_code<400&&meta.redirect_url){
     if(redirects===3){reason='reference_url_rejected';break;}
     if(!validReferenceUrl(meta.redirect_url,source)||!allowUrl(meta.redirect_url)){reason='reference_url_rejected';break;}
     url=meta.redirect_url;
     // redirect_url already includes the server's final query; don't re-append the original search.
     queryArgs=[];
     for(let i=0;i<parsed.args.length;i++){
      if(['--data','--data-urlencode','--data-raw','--data-binary','-d'].includes(parsed.args[i])){i++;continue;}
      if(parsed.args[i]==='--get'||parsed.args[i]==='-G')continue;
      queryArgs.push(parsed.args[i]);
     }
     continue;
    }
    let body;try{body=await readFile(bodyFile);}catch{reason='search_invalid_response';break;}
    reason=referenceResponseProblem(body,{source,status:meta.http_code,contentType:meta.content_type??'',expectJson:['wikipedia','moegirl'].includes(source)&&new URL(url).pathname.endsWith('/api.php'),expectImage:/^(?:bkimg\.|storage\.moegirl\.|img\.moegirl\.|upload\.wikimedia\.)/u.test(new URL(url).hostname)});
    if(reason)break;
    if(!body.length||body.length>settings.maxResponseBytes){reason='search_invalid_response';break;}
    if(parsed.output)await copyFile(bodyFile,parsed.output);
    if(route==='proxy'&&stateFile){state[key]='proxy';await writeFile(stateFile,JSON.stringify(state),{mode:0o600});}
    onEvent({source,route,ok:true,elapsedMs:now()-started});
    return {ok:true,body:parsed.output?undefined:body,url,route,elapsedMs:now()-started};
   }
   onEvent({source,route,ok:false,reason,elapsedMs:now()-started});
   if(route==='direct'&&stateFile){state[key]='proxy';await writeFile(stateFile,JSON.stringify(state),{mode:0o600});}
   if(now()>=end)break;
  }
  return {ok:false,reason:now()>=deadline?'reference_timeout':reason};
 }finally{await rm(dir,{recursive:true,force:true});}
}
