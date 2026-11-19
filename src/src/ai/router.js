import {modelReplyFailure} from '../model-reply-boundary.js';
import {measureAttempt,withMetricRequest} from './metrics.js';
import { projectionOptions } from '../conversation-projection.js';
/** Provider-neutral task routing. No vendor/model defaults, credentials or network side effects at import. */
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
const copy=value=>structuredClone(value);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,120}$/u.test(v);
const positive=(v,max=3600000)=>Number.isSafeInteger(v)&&v>0&&v<=max;
export class AiError extends Error {
  constructor(kind,message='AI task unavailable',extra={}){super(message);this.name='AiError';this.kind=kind;Object.assign(this,extra);}
}
export function errorKind(error){
  if(error?.kind)return error.kind;
  if(error?.name==='AbortError')return 'cancelled';
  if(error?.name==='TimeoutError')return 'timeout';
  const status=Number(error?.status??/HTTP\s+(\d{3})/u.exec(String(error?.code??error?.message??''))?.[1]);
  if(status>=300&&status<400)return 'invalid_request';if(status===404)return 'model_unavailable';if(status===429)return 'rate_limited';if(status>=500)return 'upstream_5xx';
  if(status===401||status===403)return 'authentication_error';
  if(status>=400)return 'invalid_request';
  return 'network_error';
}
const conditions=['timeout','network_error','rate_limited','upstream_5xx','empty_output','incomplete_output','invalid_schema','validation_failed','context_length_exceeded','model_unavailable','invalid_request','authentication_error','authorization_denied','cancelled','configuration_error','policy_blocked','disabled'];
function parameters(value){if(value!==undefined){keys(value,['maxOutputTokens','temperature','thinking','responseFormat','nativeSearch','topP','extra','size','quality','output_format','partial_images','stream','n','imageTool','operation'],'parameters');if(value.maxOutputTokens!==undefined&&!positive(value.maxOutputTokens,10000000))throw new AiError('configuration_error','Invalid token limit');if(value.temperature!==undefined&&(!Number.isFinite(value.temperature)||value.temperature<0||value.temperature>2))throw new AiError('configuration_error','Invalid temperature');if(value.extra&&(!object(value.extra)||Object.keys(value.extra).some(k=>['model','messages','input','contents','systemInstruction','stream'].includes(k))))throw new AiError('configuration_error','Protected request parameter');}}
function keys(value,allowed,label){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new AiError('configuration_error','Invalid '+label);}
export function validateAiConfig(input){
  try { projectionOptions(input); } catch { throw new AiError('configuration_error','Invalid conversation projection configuration'); }
  keys(input,['schemaVersion','revision','enabled','providers','deployments','routes','tasks','profiles','bindings','workflows','registry','extensions'],'AI configuration');
  if(input.schemaVersion!==1||typeof input.enabled!=='boolean'||!id(input.revision))throw new AiError('configuration_error','Invalid AI version');
  for(const section of ['providers','deployments','routes','tasks'])if(!object(input[section])||Object.keys(input[section]).some(k=>!id(k)))throw new AiError('configuration_error','Invalid '+section);
  for(const p of Object.values(input.providers)){
    keys(p,['adapter','baseUrl','credential','headers','transport','parameters','registryId','models','api','authHeader','authPrefix'],'provider');
    if(!['openai-chat','openai-responses','anthropic-messages','gemini-native','gemini-decisions','images','local-tts','antigravity-cli'].includes(p.adapter))throw new AiError('configuration_error','Unsupported AI adapter');
    if(p.adapter==='antigravity-cli') {
      keys(p,['adapter','registryId','parameters'],'native CLI provider');
    } else if(p.adapter!=='local-tts'){
      let u;try{u=new URL(p.baseUrl);}catch{throw new AiError('configuration_error','Invalid provider URL');}
      if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new AiError('configuration_error','Invalid provider URL');
      if(u.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw new AiError('configuration_error','Remote AI requires HTTPS');
    }
    parameters(p.parameters);
    if(p.credential&&p.adapter!=='local-tts'){keys(p.credential,['source','name','id','provider','path'],'credential reference');if(!['env','path','file','exec'].includes(p.credential.source)||p.credential.source==='env'&&!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(p.credential.name??p.credential.id??''))throw new AiError('configuration_error','Invalid credential reference');}
    if(p.headers&&(!object(p.headers)||Object.entries(p.headers).some(([k,v])=>/authorization|cookie|api[-_]?key/iu.test(k)||typeof v!=='string'||/[\r\n]/u.test(k+v))))throw new AiError('configuration_error','Invalid provider headers');
    if(p.transport){
      keys(p.transport,['mode','proxyUrl','family','tlsVerify','caFile','serverName','connectTimeoutMs','requestTimeoutMs','maxResponseBytes','certificateSha256','allowPartialTrustChain'],'transport');
      if(p.transport.allowPartialTrustChain!==undefined&&(typeof p.transport.allowPartialTrustChain!=='boolean'||p.transport.allowPartialTrustChain&&!p.transport.caFile))throw new AiError('configuration_error','Partial certificate trust requires a configured certificate');
      if(!['direct','proxy','environment'].includes(p.transport.mode)||p.transport.tlsVerify===false)throw new AiError('configuration_error','Invalid transport');
      if(p.transport.family!==undefined&&![4,6].includes(p.transport.family)||p.transport.maxResponseBytes!==undefined&&!positive(p.transport.maxResponseBytes,33554432)||p.transport.certificateSha256&&!/^[a-f0-9]{64}$/u.test(p.transport.certificateSha256))throw new AiError('configuration_error','Invalid transport limits');
      if(p.transport.mode==='proxy'){let u;try{u=new URL(p.transport.proxyUrl);}catch{}if(!u||!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new AiError('configuration_error','Invalid proxy');}
    }
  }
  for(const dep of Object.values(input.deployments)){
    keys(dep,['provider','model','capabilities','parameters','limits','thinking','compat','resources'],'deployment');
    if(!input.providers[dep.provider]||typeof dep.model!=='string'||!dep.model.trim()||/[\r\n]/u.test(dep.model))throw new AiError('configuration_error','Invalid deployment reference');
    if(!Array.isArray(dep.capabilities)||dep.capabilities.some(x=>!['text','json','vision','tools','nativeSearch','image','stream','tts'].includes(x)))throw new AiError('configuration_error','Invalid deployment capabilities');
    parameters(dep.parameters);
    if(dep.limits&&Object.values(dep.limits).some(x=>!positive(x,10000000)))throw new AiError('configuration_error','Invalid deployment limits');
  }
  for(const route of Object.values(input.routes)){
    keys(route,['steps','budgetMs','fallbackOn','stopOn'],'route');
    if(!positive(route.budgetMs)||!Array.isArray(route.steps)||!route.steps.length)throw new AiError('configuration_error','Invalid route budget');
    for(const step of route.steps){
      keys(step,['deployment','timeoutMs','retry','parameters','thinking'],'route step');
      if(!input.deployments[step.deployment]||!positive(step.timeoutMs))throw new AiError('configuration_error','Invalid route step');
      parameters(step.parameters);
      if(step.retry?.on&&(!Array.isArray(step.retry.on)||step.retry.on.some(x=>!conditions.includes(x))))throw new AiError('configuration_error','Invalid retry conditions');
      if(step.retry){keys(step.retry,['maxRetries','delayMs','on'],'retry');if(!Number.isInteger(step.retry.maxRetries)||step.retry.maxRetries<0||step.retry.maxRetries>5||step.retry.delayMs!==undefined&&(!Number.isInteger(step.retry.delayMs)||step.retry.delayMs<0||step.retry.delayMs>60000))throw new AiError('configuration_error','Invalid retry');}
    }
    if(!Array.isArray(route.fallbackOn)||route.fallbackOn.some(x=>!conditions.includes(x))||route.stopOn&&(!Array.isArray(route.stopOn)||route.stopOn.some(x=>!conditions.includes(x))))throw new AiError('configuration_error','Invalid fallback conditions');
  }
  for(const task of Object.values(input.tasks)){
    keys(task,['enabled','route','requires','validator','inputPolicy','parameters'],'task');
    parameters(task.parameters);
    if(task.inputPolicy){keys(task.inputPolicy,['maxBytes','maxTokens','imageTokens'],'input policy');if(Object.values(task.inputPolicy).some(x=>!positive(x,100000000)))throw new AiError('configuration_error','Invalid input limits');}
    if(typeof task.enabled!=='boolean'||!input.routes[task.route]||!Array.isArray(task.requires))throw new AiError('configuration_error','Invalid task');
    for(const step of input.routes[task.route].steps){const dep=input.deployments[step.deployment];if(task.requires.some(x=>!dep.capabilities.includes(x)))throw new AiError('configuration_error','Task capability mismatch');
      const max=task.parameters?.maxOutputTokens??step.parameters?.maxOutputTokens??dep.parameters?.maxOutputTokens??input.providers[dep.provider].parameters?.maxOutputTokens;
      if(max!==undefined&&(!positive(max,10000000)||dep.limits?.maxOutputTokens&&max>dep.limits.maxOutputTokens))throw new AiError('configuration_error','Task output exceeds deployment limit');}
  }
  for(const profile of Object.values(input.profiles??{}))for(const [taskId,routeId] of Object.entries(profile)){
    const task=input.tasks[taskId],route=input.routes[routeId];if(!task||!route)throw new AiError('configuration_error','Invalid profile reference');
    for(const step of route.steps){const dep=input.deployments[step.deployment];if(task.requires.some(x=>!dep.capabilities.includes(x)))throw new AiError('configuration_error','Profile capability mismatch');}
  }
  // Deep freeze protects an in-flight snapshot from hot reload or caller mutation.
  const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
  return freeze(copy(input));
}
export function createConfigStore(path,{onInvalid=()=>{}}={}){
  let good,hash;
  return {snapshot(){
    try{
      const raw=readFileSync(path,'utf8'),next=createHash('sha256').update(raw).digest('hex');
      if(next!==hash){const validated=validateAiConfig(JSON.parse(raw));good=validated;hash=next;}
      return good;
    }catch{onInvalid({kind:'configuration_error'});if(good)return good;throw new AiError('configuration_error','AI configuration unavailable');}
  }};
}
export function taskPlan(config,taskId,{profile,metadata=false}={}){
  const task=config.tasks[taskId];if(!task||!metadata&&(!config.enabled||!task.enabled))throw new AiError('disabled','AI task disabled');
  const routeId=config.profiles?.[profile]?.[taskId]??task.route,route=config.routes[routeId];
  if(!route)throw new AiError('configuration_error','AI route unavailable');
  return {task,route,routeId,revision:config.revision,steps:route.steps.map(step=>{
    const dep=config.deployments[step.deployment],provider=config.providers[dep.provider];
    return {...step,deploymentId:step.deployment,deployment:dep,providerId:dep.provider,provider,parameters:{...provider.parameters,...dep.parameters,...step.parameters,...task.parameters}};
  })};
}
/** Conservative UTF-8 estimate plus the configured charge for each structured image. */
export function estimateInputTokens(input,imageTokens=0){
  let images=0;
  const visit=value=>{
    if(typeof value==='string'&&value.startsWith('data:image/')){images++;return '[inline-image]';}
    if(Array.isArray(value))return value.map(visit);
    if(!object(value))return value;
    const image=['image_url','input_image','image'].includes(value.type);
    const inline=value.inlineData??value.inline_data;
    if(image){images++;return {...value,image_url:'[image]',url:undefined,source:undefined,data:undefined};}
    if(inline&&String(inline.mimeType??inline.mime_type??'').startsWith('image/')){images++;return {inlineData:{mimeType:inline.mimeType??inline.mime_type,data:'[image]'}};}
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v)]));
  };
  return Math.ceil(Buffer.byteLength(JSON.stringify(visit(input))??'')/2)+images*imageTokens;
}
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{signal?.throwIfAborted();const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal?.addEventListener('abort',abort,{once:true});});
export function createAiRouter({getConfig,invoke,validators={},onEvent=()=>{}}){
  const event=value=>{try{onEvent(value);}catch{}};
  return {async run(taskId,{input,signal,requestId,context={},validate,timeoutMs}={}){
    if(signal?.aborted)throw new AiError('cancelled');if(timeoutMs!==undefined&&!positive(timeoutMs,Number.MAX_SAFE_INTEGER))throw new AiError('invalid_request','Invalid task timeout');const config=getConfig(),plan=taskPlan(config,taskId,{profile:context.aiProfile});
    const metricId=requestId??randomUUID();
    const deadline=Date.now()+Math.min(plan.route.budgetMs,timeoutMs??Infinity);
    const budgetSignal=AbortSignal.timeout(Math.max(1,deadline-Date.now()));
    const bounded=signal?AbortSignal.any([signal,budgetSignal]):budgetSignal;
    const frozenInput=copy(input);const inputBytes=Buffer.byteLength(JSON.stringify(frozenInput)??'');if(plan.task.inputPolicy?.maxBytes&&inputBytes>plan.task.inputPolicy.maxBytes)throw new AiError('invalid_request','AI input exceeds configured byte limit');let last;
    for(let index=0;index<plan.steps.length;index++){
      const step=plan.steps[index];let advance=false;
      const estimate=estimateInputTokens(frozenInput,plan.task.inputPolicy?.imageTokens??0)+(step.parameters.maxOutputTokens??0);
      if((plan.task.inputPolicy?.maxTokens&&estimate-(step.parameters.maxOutputTokens??0)>plan.task.inputPolicy.maxTokens)||(step.deployment.limits?.contextTokens&&estimate>step.deployment.limits.contextTokens)){
        last=new AiError('context_length_exceeded');
        const fallback=plan.route.fallbackOn.includes(last.kind);
        measureAttempt(step,context,metricId,{taskId,routeId:plan.routeId,deploymentId:step.deploymentId,revision:plan.revision,
          index,retry:0,elapsedMs:0,ok:false,kind:last.kind,skipped:true,next:fallback&&index+1<plan.steps.length?'fallback':'stop'});
        if(fallback)continue;throw last;
      }
      for(let retry=0;retry<=(step.retry?.maxRetries??0);retry++){
        if(signal?.aborted)throw new AiError('cancelled');if(bounded.aborted)throw new AiError('timeout','AI task budget exhausted');
        const started=Date.now(),duration=Math.max(1,Math.min(step.timeoutMs,deadline-started));
        const attemptSignal=AbortSignal.any([bounded,AbortSignal.timeout(duration)]);
        let abort;
        try{
          // race also bounds injected transports which fail to respect AbortSignal.
          const aborted=new Promise((_,reject)=>{abort=()=>reject(new AiError(signal?.aborted?'cancelled':'timeout'));attemptSignal.addEventListener('abort',abort,{once:true});if(attemptSignal.aborted)abort();});
          const work=(async()=>{
            const result=await withMetricRequest(metricId,taskId,()=>invoke({...step,input:copy(frozenInput),signal:attemptSignal,timeoutMs:duration,context:{...context},taskId,requestId,revision:plan.revision}));
            if(attemptSignal.aborted)throw new AiError('timeout');
            if(!result||result.complete===false)throw new AiError('incomplete_output');
            if(typeof result.text!=='string'||!result.text.trim())throw new AiError('empty_output');
            const validator=validate??validators[plan.task.validator];
            if(plan.task.validator&&!validator)throw new AiError('configuration_error','AI validator unavailable');
            try{const value=await validator?.(result.text,result);if(value!==undefined)result.value=value;}catch(e){if(e instanceof AiError)throw e;throw new AiError('validation_failed','AI output validation failed');}
            return result;
          })();
          const result=await Promise.race([work,aborted]);
          const record={taskId,routeId:plan.routeId,deploymentId:step.deploymentId,revision:plan.revision,index,retry,elapsedMs:Date.now()-started,ok:true};
          event(record);measureAttempt(step,context,metricId,record,result.nativeModel??result.actualModel??result.raw?.modelVersion??result.raw?.model);
          return {...result,model:step.deployment.model,providerId:step.providerId,deploymentId:step.deploymentId,routeId:plan.routeId,revision:plan.revision};
        }catch(error){
          const kind=signal?.aborted?'cancelled':attemptSignal.aborted?'timeout':errorKind(error);last=new AiError(kind,'AI task attempt failed');
          const record={taskId,routeId:plan.routeId,deploymentId:step.deploymentId,revision:plan.revision,index,retry,elapsedMs:Date.now()-started,ok:false,kind};
          const eligible=!signal?.aborted&&!plan.route.stopOn?.includes(kind)&&plan.route.fallbackOn.includes(kind);
          const again=eligible&&retry<(step.retry?.maxRetries??0)&&(step.retry.on??plan.route.fallbackOn).includes(kind);
          event(record);measureAttempt(step,context,metricId,{...record,next:again?'retry':eligible&&index+1<plan.steps.length?'fallback':'stop'});
          if(signal?.aborted)throw last;
          if(plan.route.stopOn?.includes(kind)||!plan.route.fallbackOn.includes(kind))throw last;
          if(again){await sleep(Math.min(step.retry.delayMs??0,Math.max(0,deadline-Date.now())),bounded).catch(()=>{throw new AiError(signal?.aborted?'cancelled':'timeout');});continue;}
          advance=true;break;
        }finally{if(abort)attemptSignal.removeEventListener('abort',abort);}
      }
      if(!advance)break;
    }
    throw last??new AiError('configuration_error','AI route exhausted');
  }};
}
export function decodeText(data,adapter){
  let text;
  if(adapter==='gemini-decisions'){
    if(!object(data?.answers)||!Object.keys(data.answers).length||data.error)throw new AiError('invalid_schema');
    return JSON.stringify(data.answers);
  }
  if(adapter==='openai-responses'){
    if(data?.output?.some(x=>x.type==='message'&&x.content?.some(p=>p.type==='refusal')))throw new AiError('policy_blocked');
    if(data?.status!=='completed'||data.error)throw new AiError('incomplete_output');
    text=data.output_text??(data.output??[]).filter(x=>x.type==='message').flatMap(x=>x.content??[]).filter(x=>x.type==='output_text').map(x=>x.text??'').join('');
  }else if(adapter==='anthropic-messages'){
    if(data?.stop_reason==='refusal'||data?.content?.some(part=>part.type==='refusal'))throw new AiError('policy_blocked');
    if(!['end_turn','stop_sequence'].includes(data?.stop_reason)||data?.error)throw new AiError('incomplete_output');
    text=(data.content??[]).filter(part=>part.type==='text').map(part=>part.text??'').join('');
  }else if(adapter==='gemini-native'){
    const c=data?.candidates?.[0];if(data?.promptFeedback?.blockReason||['SAFETY','PROHIBITED_CONTENT','BLOCKLIST','SPII'].includes(c?.finishReason))throw new AiError('policy_blocked');if(c?.finishReason!=='STOP')throw new AiError(c?.finishReason?'incomplete_output':'empty_output');text=(c.content?.parts??[]).filter(x=>!x.thought).map(x=>x.text??'').join('');
  }else{
    const c=data?.choices?.[0];if(c?.message?.refusal||c?.finish_reason==='content_filter')throw new AiError('policy_blocked');if(c?.finish_reason!=='stop'||c.message?.tool_calls?.length)throw new AiError('incomplete_output');text=c.message?.content;
  }
  if(typeof text!=='string'||!text.trim())throw new AiError('empty_output');const failure=modelReplyFailure({text});if(failure)throw new AiError(failure.kind);return text;
}
function responseMessages(messages){
  return messages.map(message=>({...message,content:typeof message.content==='string'?message.content:message.content.map(part=>{
    if(['text','input_text','output_text'].includes(part.type))return {type:message.role==='assistant'?'output_text':'input_text',text:part.text};
    if(part.type==='image_url'||part.type==='input_image'){
      const image=part.image_url;
      return {type:'input_image',image_url:typeof image==='string'?image:image?.url,...(image?.detail??part.detail?{detail:image?.detail??part.detail}:{})};
    }
    throw new AiError('invalid_request','Unsupported Responses input part');
  })}));
}
function anthropicContent(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))throw new AiError('invalid_request','Unsupported Anthropic message content');
  return content.map(part=>{
    if(['text','input_text','output_text'].includes(part.type))return {type:'text',text:part.text};
    if(part.type==='image_url'||part.type==='input_image'){
      const url=typeof part.image_url==='string'?part.image_url:part.image_url?.url;
      const inline=/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/su.exec(url??'');
      if(inline)return {type:'image',source:{type:'base64',media_type:inline[1],data:inline[2]}};
      if(/^https?:\/\//u.test(url??''))return {type:'image',source:{type:'url',url}};
    }
    throw new AiError('invalid_request','Unsupported Anthropic input part');
  });
}
export function requestShape(step){
  const {provider,parameters:p,deployment:dep,input}=step;
  const messages=input.messages??[{role:'system',content:input.instruction??'Return JSON only.'},{role:'user',content:typeof input==='string'?input:(typeof input.value==='string'?input.value:JSON.stringify(input.value??input))}];
  const tokens=p.maxOutputTokens,thinking=p.thinking??step.thinking??dep.thinking;
  let body,path;
  if(provider.adapter==='gemini-decisions'){
    if(typeof input.input!=='string'||!object(input.questions)||!Object.keys(input.questions).length)throw new AiError('invalid_request','Decision input and questions required');
    path='/decisions';body={model:dep.model,input:input.input,questions:copy(input.questions)};
  }else if(provider.adapter==='openai-responses'){
    path='/responses';body={model:dep.model,input:responseMessages(messages),stream:false,store:false,...(tokens?{max_output_tokens:tokens}:{})};
    if(thinking&&dep.compat?.supportsReasoningEffort!==false)body.reasoning={effort:thinking};
    if(p.temperature!==undefined)body.temperature=p.temperature;
    if(p.responseFormat==='json')body.text={format:{type:'json_object'}};
  }else if(provider.adapter==='anthropic-messages'){
    path=/\/v1\/?$/u.test(provider.baseUrl)?'/messages':'/v1/messages';
    const system=messages.filter(message=>['system','developer'].includes(message.role)).flatMap(message=>{
      const content=anthropicContent(message.content);return typeof content==='string'?[{type:'text',text:content}]:content;
    });
    if(system.some(part=>part.type!=='text'))throw new AiError('invalid_request','Anthropic system content must be text');
    const conversation=messages.filter(message=>!['system','developer'].includes(message.role));
    if(conversation.some(message=>!['user','assistant'].includes(message.role)))throw new AiError('invalid_request','Unsupported Anthropic message role');
    const maxTokens=tokens??dep.limits?.maxOutputTokens;
    if(!Number.isSafeInteger(maxTokens)||maxTokens<=0)throw new AiError('configuration_error','Anthropic requires configured maxOutputTokens');
    body={model:dep.model,max_tokens:maxTokens,messages:conversation.map(message=>({role:message.role,content:anthropicContent(message.content)})),stream:false,...(system.length?{system}:{} )};
    if(p.temperature!==undefined)body.temperature=p.temperature;
  }else if(provider.adapter==='gemini-native'){
    path='/models/'+encodeURIComponent(dep.model)+':generateContent';
    const system=messages.filter(x=>x.role==='system').map(x=>x.content).join('\n');
    body={...(system?{systemInstruction:{parts:[{text:system}]}}:{}),contents:messages.filter(x=>x.role!=='system').map(x=>({role:x.role==='assistant'?'model':'user',parts:typeof x.content==='string'?[{text:x.content}]:x.content.map(p=>p.type==='text'?{text:p.text}:imagePart(p.image_url?.url))})),generationConfig:{...(tokens?{maxOutputTokens:tokens}:{}),...(p.responseFormat==='json'?{responseMimeType:'application/json'}:{})}};
    if(p.temperature!==undefined)body.generationConfig.temperature=p.temperature;
    if(p.nativeSearch)body.tools=[{googleSearch:{}}];
  }else if(provider.adapter==='openai-chat'){
    path='/chat/completions';body={model:dep.model,messages,stream:false,...(tokens?{max_tokens:tokens}:{})};
    if(p.temperature!==undefined)body.temperature=p.temperature;
    if(thinking&&dep.compat?.supportsReasoningEffort!==false)body.reasoning_effort=dep.compat?.supportedReasoningEfforts?.length&&!dep.compat.supportedReasoningEfforts.includes(thinking)?dep.compat.supportedReasoningEfforts[0]:thinking;
    if(p.responseFormat==='json')body.response_format={type:'json_object'};
  }else throw new AiError('configuration_error','Task is not a text protocol');
  if(p.topP!==undefined){if(provider.adapter==='gemini-native')body.generationConfig.topP=p.topP;else body.top_p=p.topP;}
  if(p.extra){for(const key of Object.keys(p.extra))if(['model','messages','input','contents','systemInstruction','stream'].includes(key))throw new AiError('configuration_error','Protected request parameter');Object.assign(body,p.extra);}
  return {url:provider.baseUrl.replace(/\/$/u,'')+path,body};
}
function imagePart(url){const m=/^data:([^;]+);base64,(.+)$/su.exec(url??'');if(!m)throw new AiError('invalid_request','Native vision requires inline image input');return {inlineData:{mimeType:m[1],data:m[2]}};}
export function createFetchInvoker({fetchImpl=fetch,credential=async p=>process.env[p.credential?.name]}={}){
  return async step=>{
    const {url,body}=requestShape(step);const key=await credential(step.provider);if(!key)throw new AiError('authentication_error');
    const header=step.provider.authHeader??(['gemini-native','gemini-decisions'].includes(step.provider.adapter)?'x-goog-api-key':step.provider.adapter==='anthropic-messages'?'x-api-key':'Authorization'),prefix=step.provider.authPrefix??(['gemini-native','gemini-decisions','anthropic-messages'].includes(step.provider.adapter)?'':'Bearer ');
    let result;
    if(fetchImpl===globalThis.fetch&&step.provider.transport){const {requestAiJson}=await import('./http.js');const raw=await requestAiJson(url,{apiKey:key,body,signal:step.signal,timeoutMs:step.timeoutMs,transport:step.provider.transport,headers:step.provider.headers,authHeader:header,authPrefix:prefix});return {text:decodeText(raw,step.provider.adapter),complete:true,raw,usage:raw.usage??raw.usageMetadata};}
    try{result=await fetchImpl(url,{method:'POST',signal:step.signal,headers:{...step.provider.headers,[header]:prefix+key,'Content-Type':'application/json'},body:JSON.stringify(body)});}catch(e){if(step.signal.aborted)throw new AiError('timeout');throw new AiError('network_error');}
    if(!result.ok)throw new AiError(errorKind({status:result.status}),undefined,{status:result.status});
    let raw;try{raw=await result.json();}catch{throw new AiError('invalid_schema');}
    return {text:decodeText(raw,step.provider.adapter),complete:true,usage:raw.usage??raw.usageMetadata,raw};
  };
}
