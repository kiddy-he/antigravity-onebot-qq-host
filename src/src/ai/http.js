/** Configured HTTP transport. Secrets stay in environment/stdin, never command arguments or logs. */
import http from 'node:http';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {AiError,errorKind} from './router.js';
// Gateways may wrap upstream connection failures in HTTP 400. Inspect only
// bounded, known error fields; do not retain bodies which may contain secrets.
export function aiHttpError(status,body=''){
  let data;try{data=JSON.parse(String(body).slice(0,131072));}catch{}
  const e=data?.error;
  const codes=[e?.code,e?.type,e?.status,e?.gateway_error?.error_code].filter(v=>typeof v==='string').map(v=>v.toLowerCase());
  let kind=errorKind({status});
  if(status===400||status===422){
    if(codes.some(c=>['content_policy_violation','policy_blocked','safety','prohibited_content'].includes(c)))kind='policy_blocked';
    else if(codes.some(c=>['upstream_network_error','network_error','connection_error'].includes(c)))kind='network_error';
    else if(codes.some(c=>['upstream_timeout','request_timeout','timeout_error'].includes(c)))kind='timeout';
    else if(e?.status==='INVALID_ARGUMENT'&&typeof e.message==='string'&&e.message.includes('URL_UNREACHABLE-UNREACHABLE_CONNECT_TIMEOUT'))kind='network_error';
  }
  return new AiError(kind,undefined,{status});
}
export function requestAiJson(url,{apiKey,body,timeoutMs=30000,headers={},signal,transport={},authHeader='Authorization',authPrefix='Bearer ',execute=execFile}={}){
  if(signal?.aborted)throw new AiError('cancelled');const target=new URL(url);
  if(!['https:','http:'].includes(target.protocol)||target.username||target.password)throw new AiError('configuration_error');
  if(!apiKey||/[\r\n]/u.test(apiKey)||!/^[a-zA-Z0-9-]+$/u.test(authHeader)||/[\r\n]/u.test(authPrefix))throw new AiError('configuration_error');
  const protectedHeaders={};for(const [k,v] of Object.entries(headers)){if(/^(authorization|cookie|proxy-authorization|x-api-key|api-key)$/iu.test(k)||/[\r\n]/u.test(k+v))continue;protectedHeaders[k.toLowerCase()]=v;}
  protectedHeaders[authHeader.toLowerCase()]=authPrefix+apiKey;protectedHeaders['content-type']='application/json';protectedHeaders.accept='application/json';
  const maxResponseBytes=transport.maxResponseBytes??2*1024*1024;
  if(transport.mode==='proxy'||transport.mode==='environment'){
    const script='exec /usr/bin/curl -q -sS '+(transport.mode==='proxy'?'--proxy "$AI_PROXY" ':transport.mode==='environment'?'':'--noproxy "*" ')+(transport.family===6?'-6 ':transport.family===4?'-4 ':'')+(transport.caFile?'--cacert "$AI_CA_FILE" ':'')+'--connect-timeout "$AI_CONNECT_SECONDS" --max-time "$AI_SECONDS" -H @/dev/fd/3 "$AI_URL" --data-binary @- -w "\\n%{http_code}" 3<<AI_HEADERS\n'+Object.entries(protectedHeaders).map(([k])=>`${k}: $AI_HEADER_${Object.keys(protectedHeaders).indexOf(k)}`).join('\n')+'\nAI_HEADERS\n';
    return new Promise((resolve,reject)=>{
      const env={...process.env,AI_PROXY:transport.proxyUrl??'',AI_CA_FILE:transport.caFile??'',AI_URL:url,AI_CONNECT_SECONDS:String(Math.max(1,Math.ceil((transport.connectTimeoutMs??10000)/1000))),AI_SECONDS:String(Math.max(1,Math.ceil(timeoutMs/1000)))};
      Object.values(protectedHeaders).forEach((v,i)=>{env['AI_HEADER_'+i]=String(v);});
      const child=execute('/bin/sh',['-c',script],{env,timeout:timeoutMs+1000,signal,maxBuffer:maxResponseBytes},(error,stdout)=>{
        if(error)return reject(new AiError(signal?.aborted?'cancelled':error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'invalid_schema':error.code===28||error.killed?'timeout':'network_error'));
        const at=stdout.lastIndexOf('\n'),status=Number(stdout.slice(at+1));
        if(status<200||status>=300)return reject(aiHttpError(status,stdout.slice(0,at)));
        try{resolve(JSON.parse(stdout.slice(0,at)));}catch{reject(new AiError('invalid_schema'));}
      });
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(body));
    });
  }
  return new Promise((resolve,reject)=>{
    let settled=false,req;const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){req?.destroy();reject(error);}else resolve(result);};
    const abort=()=>finish(new AiError('cancelled'));const timer=setTimeout(()=>finish(new AiError('timeout')),timeoutMs);signal?.addEventListener('abort',abort,{once:true});
    let ca;try{if(transport.caFile)ca=readFileSync(transport.caFile);}catch{return finish(new AiError('configuration_error'));}
    const tls={...(ca?{ca}:{}),...(transport.allowPartialTrustChain?{allowPartialTrustChain:true,agent:false}:{}),...(transport.serverName?{servername:transport.serverName}:{}),rejectUnauthorized:true,...(transport.family?{family:transport.family,autoSelectFamily:false}:{}),...(transport.certificateSha256?{checkServerIdentity(_host,cert){return cert.raw&&createHash('sha256').update(cert.raw).digest('hex')===transport.certificateSha256?undefined:new Error('Certificate pin mismatch');}}:{})};
    req=(target.protocol==='https:'?https:http).request(target,{method:'POST',...(target.protocol==='https:'?tls:{}),headers:protectedHeaders},res=>{
      const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>maxResponseBytes)finish(new AiError('invalid_schema'));else chunks.push(chunk);});
      res.on('error',()=>finish(new AiError('network_error')));res.on('aborted',()=>finish(new AiError('network_error')));
      res.on('end',()=>{const body=Buffer.concat(chunks).toString('utf8');if(res.statusCode<200||res.statusCode>=300)return finish(aiHttpError(res.statusCode,body));try{finish(null,JSON.parse(body));}catch{finish(new AiError('invalid_schema'));}});
    });
    req.on('error',()=>finish(new AiError('network_error')));if(signal?.aborted){abort();return;}req.end(JSON.stringify(body));
  });
}
