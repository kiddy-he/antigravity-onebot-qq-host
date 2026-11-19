import {onebotPath as publicPath} from '../src/src/paths.js';
/** Configured streaming image transport used by the existing image workflow. */
import {mkdtempSync,writeFileSync,readFileSync,rmSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {loadAiConfig} from '../src/src/ai/config.js';
import {taskPlan,errorKind,AiError} from '../src/src/ai/router.js';
import {credentialFor} from '../src/src/ai/client.js';
import {normalizeImageOutput} from '../src/src/ai/image-output.js';
const skill=publicPath("workspace/skills/agy-proxy/scripts");
const run=(cmd,args,options={})=>new Promise(resolve=>{const child=spawn(cmd,args,{...options,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('error',()=>resolve({code:127,stdout,stderr:''}));child.on('close',code=>resolve({code,stdout,stderr}));});
export function imageArguments(step,format,original,{headerFile,bodyFile,responseFile,headersFile,timeoutMs}){
 const p=step.parameters,transport=step.provider.transport??{};
 const args=['-q','--silent','--show-error','--no-buffer','--connect-timeout',String(Math.ceil((transport.connectTimeoutMs??30000)/1000)),'--max-time',String(Math.max(1,Math.ceil(timeoutMs/1000))),'--dump-header',headersFile,'--output',responseFile,'--write-out','%{http_code}','-H','@'+headerFile];
 if(transport.mode==='proxy')args.push('--proxy',transport.proxyUrl,'--noproxy','');else if(transport.mode!=='environment')args.push('--noproxy','*');
 if(transport.family)args.push(transport.family===6?'-6':'-4');if(transport.caFile)args.push('--cacert',transport.caFile);
 if(transport.tlsVerify===false)throw new AiError('configuration_error');
 const endpoint=(format==='responses-sse'||format==='sse')?'/responses':original.includes('-F')?'/images/edits':'/images/generations';
 const configured={...p.extra,...p,model:step.deployment.model,stream:true};delete configured.extra;delete configured.operation;delete configured.maxOutputTokens;delete configured.thinking;
 if(original.includes('-F')){
   for(let i=0;i<original.length;i++)if(original[i]==='-F'){const form=original[++i],name=form.split('=')[0];if(!new Set(['model','size','quality','stream','partial_images','output_format','n',...Object.keys(configured)]).has(name))args.push('-F',form);}
   for(const [k,v] of Object.entries(configured))if(v!==undefined)args.push('-F',`${k}=${v}`);
 }else{
   const at=original.indexOf('--data-binary'),raw=original[at+1];if(at<0)throw new AiError('invalid_request');
   const body=JSON.parse(raw.startsWith('@')?readFileSync(raw.slice(1),'utf8'):raw);delete body.model;
   if((format==='responses-sse'||format==='sse')){
     // The configured text deployment orchestrates the image tool; tool options also live in configuration.
     Object.assign(body,configured);if(p.imageTool)body.tools=[{type:'image_generation',...p.imageTool}];delete body.imageTool;
   }else Object.assign(body,configured);
   writeFileSync(bodyFile,JSON.stringify(body),{mode:0o600});args.push('-H','Content-Type: application/json','--data-binary','@'+bodyFile);
 }
 args.push(step.provider.baseUrl.replace(/\/$/u,'')+endpoint);return args;
}
/** Classify provider availability independently from policy/parameter failures. */
export function imageFailureKind(data,{status=0,transportKind=null}={}){
 const error=data?.error??{},codes=[error.code,error.type].filter(x=>typeof x==='string').join(' ').toLowerCase();
 // Explicit safety/permission decisions must never be retried on another provider.
 if(/content[_-]?policy|policy[_-]?violation|refus|moderation|safety/iu.test(codes))return 'policy_blocked';
 if(/permission|access[_-]?denied|authorization[_-]?denied/iu.test(codes))return 'authorization_denied';
 if(/invalid[_-]?(value|param|request)|unsupported[_-]?(param|value)/iu.test(codes))return 'invalid_request';
 if(status===401||/authentication|invalid[_-]?api[_-]?key|incorrect[_-]?api[_-]?key/iu.test(codes))return 'authentication_error';
 if(status===429||/rate[_-]?limit|insufficient[_-]?quota|quota[_-]?(exceeded|exhausted)/iu.test(codes))return 'rate_limited';
 if(status===404||/model[_-]?(not[_-]?found|unavailable|not[_-]?available)|unsupported[_-]?model/iu.test(codes))return 'model_unavailable';
 if(status>=500||/server[_-]?error|upstream[_-]?error|overloaded|temporar|service[_-]?unavailable/iu.test(codes))return 'upstream_5xx';
 if(transportKind)return transportKind;
 // An unknown terminal error is deliberately not guessed to be retryable.
 if(data?._stream?.retryable===false)return 'invalid_request';
 return 'incomplete_output';
}
export async function imageHttp({label,format,responseFile,original,config=loadAiConfig(),execute=run,credential=credentialFor}){
 const taskId=(format==='responses-sse'||format==='sse')?'image.reference.generate':'image.generate',plan=taskPlan(config,taskId);
 const deadline=Math.min(Date.now()+plan.route.budgetMs,Number(process.env.AGY_IMAGE_POLICY_DEADLINE??Infinity)*1000);
 const dir=mkdtempSync(join(tmpdir(),'ai-image-'));let finalStatus='000',exit=124,attempt=0;
 try{
  for(const step of plan.steps)for(let retry=0;retry<=(step.retry?.maxRetries??0);retry++){
   const timeoutMs=Math.min(step.timeoutMs,deadline-Date.now());if(timeoutMs<=0)throw new AiError('timeout');attempt++;
   const headerFile=join(dir,'headers'),bodyFile=join(dir,'body'),headersFile=join(dir,'response-headers'),errorFile=join(dir,'error');
   const key=await credential(step.provider);if(!key||/[\r\n]/u.test(key))throw new AiError('authentication_error');
   writeFileSync(headerFile,[(step.provider.authHeader??'Authorization')+': '+(step.provider.authPrefix??'Bearer ')+key,...Object.entries(step.provider.headers??{}).map(([k,v])=>k+': '+v)].join('\n')+'\n',{mode:0o600});
   writeFileSync(responseFile,'',{mode:0o600});
   const args=imageArguments(step,format,original,{headerFile,bodyFile,responseFile,headersFile,timeoutMs});
   const result=await execute('curl',args,{timeout:timeoutMs+1000});exit=result.code??1;finalStatus=result.stdout.trim()||'000';writeFileSync(errorFile,result.stderr??'',{mode:0o600});
   let kind=exit===28?'timeout':exit?'network_error':Number(finalStatus)>=400?errorKind({status:Number(finalStatus)}):null,success=false,images=[],reported={};
   if(format==='image-sse'){
    copyFileSync(responseFile,responseFile+'.sse');await execute('/usr/bin/python3.12',[skill+'/image-stream.py',responseFile+'.sse',responseFile],{timeout:15000});
    let data;try{data=JSON.parse(readFileSync(responseFile,'utf8'));}catch{}
    success=Number(finalStatus)>=200&&Number(finalStatus)<300&&data?._stream?.completed&&data?.data?.length>0&&!data.error;
    reported={model:data?.model,size:data?.size,quality:data?.quality};
    if(success){
     try{const normalized=await normalizeImageOutput(data);data=normalized.data;images=normalized.images;writeFileSync(responseFile,JSON.stringify(data),{mode:0o600});}
     catch{success=false;kind='incomplete_output';exit=exit||65;data={error:{code:'invalid_final_image',message:'Image response contains invalid final image data'},_stream:{...data?._stream,completed:false,retryable:true}};writeFileSync(responseFile,JSON.stringify(data),{mode:0o600});}
    }
    if(success){exit=0;kind=null;}else kind=imageFailureKind(data,{status:Number(finalStatus),transportKind:kind});
   }else{
    const raw=readFileSync(responseFile,'utf8'),events=raw.split('\n').filter(x=>x.startsWith('data: ')).flatMap(x=>{try{return [JSON.parse(x.slice(6))];}catch{return [];}}),completed=events.find(x=>x.type==='response.completed');
    success=!kind&&completed&&!completed.response?.error&&completed.response?.output?.some(x=>x.type==='image_generation_call'&&x.result);
    if(!success)kind=completed?'invalid_request':kind??'incomplete_output';
   }
   writeFileSync(responseFile+'.curl-exit',String(exit),{mode:0o600});
   writeFileSync(responseFile+'.ai-meta',JSON.stringify({taskId,revision:plan.revision,deploymentId:step.deploymentId,providerId:step.providerId,model:step.deployment.model,requested:{size:step.parameters.size,quality:step.parameters.quality,response_format:step.parameters.extra?.response_format??step.parameters.response_format},reported,images,attempt,status:finalStatus,kind}),{mode:0o600});
   await execute('/usr/bin/python3.12',[skill+'/image-diagnostics.py',label,format,responseFile,headersFile,errorFile,finalStatus,String(exit),String(attempt),String(Math.ceil((step.timeoutMs-timeoutMs)/1000)),success?'success':'failed'],{env:{...process.env,AGY_IMAGE_DIAGNOSTIC_ENDPOINT:step.provider.baseUrl,AGY_IMAGE_DIAGNOSTIC_MODEL:step.deployment.model},timeout:15000});
   if(success)return finalStatus;
   copyFileSync(responseFile,responseFile+'.attempt-'+attempt);
   if(plan.route.stopOn?.includes(kind)||!plan.route.fallbackOn.includes(kind))return finalStatus;
   const again=retry<(step.retry?.maxRetries??0)&&(step.retry.on??plan.route.fallbackOn).includes(kind);
   if(again){const wait=Math.min(step.retry.delayMs??0,Math.max(0,deadline-Date.now()));if(wait)await new Promise(r=>setTimeout(r,wait));}else break;
  }
  return finalStatus;
 }finally{rmSync(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [label,format,responseFile,...original]=process.argv.slice(2);
 try{console.log(await imageHttp({label,format,responseFile,original}));}catch(error){writeFileSync(responseFile,JSON.stringify({error:{code:error.kind??'image_request_failed'}}),{mode:0o600});writeFileSync(responseFile+'.curl-exit','124',{mode:0o600});console.log('000');}
}
