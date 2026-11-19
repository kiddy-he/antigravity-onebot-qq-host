import {CLI_ADAPTER,invokeCliStep} from './ai/antigravity-cli.js';
import {runTaskCallback} from './ai/callback.js';
import {credentialFor} from './ai/client.js';
/** Legacy function names retained as adapters to the configuration-owned task routes. */
import {readFile} from 'node:fs/promises';
import {onebotPath} from './paths.js';
import {loadModelRouting} from './model-routing.js';
import {resolveProviderCredential} from './llm-credentials.js';
import {loadAiConfig,firstTaskRoute,configuredTaskRoutes} from './ai/config.js';
import {requestAiJson} from './ai/http.js';
import {decodeText,AiError,errorKind,requestShape} from './ai/router.js';
export const OFFICIAL_FLASH_LITE=firstTaskRoute('inbound.intent',{metadata:true}).model;
export const isFlashLite=route=>(loadAiConfig().workflows?.compatibility?.flashLiteModelLabels??[]).includes(String(route?.model??route));
export function flashLiteRoutes(primary,routing){
  if(primary?.taskId)return configuredTaskRoutes(primary.taskId,{profile:primary.aiProfile});
  routing??=loadModelRouting();
  const configured=primary?.taskId;
  if(!isFlashLite(primary))return [primary];
  return [primary,...(routing.flashLiteFallbacks??[])].filter((r,i,a)=>a.findIndex(x=>x.model===r.model&&x.thinking===r.thinking)===i);
}
export async function withFlashLiteFallback(primary,invoke,{routing,signal,log}={}){
  if(primary?.taskId){
    return runTaskCallback(primary.taskId,invoke,{profile:primary.aiProfile,signal});
  }
  let last;const config=loadAiConfig(),policy=primary?.taskId?config.routes[config.tasks[primary.taskId]?.route]:undefined;
  for(const route of flashLiteRoutes(primary,routing)){
    signal?.throwIfAborted();try{return await invoke(route);}catch(error){signal?.throwIfAborted();last=error;
      const kind=errorKind(error);if(policy&&(policy.stopOn?.includes(kind)||!policy.fallbackOn.includes(kind)))throw error;
      log?.warn?.(`[onebot] Configured task attempt failed task=${primary.taskId??'compatibility'} kind=${kind}`);
    }
  }
  throw last??new AiError('configuration_error');
}
export function requestOfficialGeminiJson(url,options){
  const provider=firstTaskRoute('inbound.intent').ai.provider;
  if(new URL(url).origin!==new URL(provider.baseUrl).origin)throw Error('Invalid configured provider host');
  return requestAiJson(url,{...options,transport:provider.transport});
}
export function compatibleChatBody(config,route,body){
  const separator=route.model.indexOf('/'),providerId=route.model.slice(0,separator),model=route.model.slice(separator+1),provider=config.models?.providers?.[providerId];
  const compat=route.ai?.deployment.compat??provider?.models?.find(x=>x.id===model)?.compat??{};
  const parameters=route.parameters??{},value={...body,model,stream:false};
  if(parameters.maxOutputTokens)value.max_tokens=parameters.maxOutputTokens;
  if(parameters.temperature!==undefined)value.temperature=parameters.temperature;
  if(compat.supportsReasoningEffort===false)delete value.reasoning_effort;
  else {const supported=compat.supportedReasoningEfforts;value.reasoning_effort=supported?.length&&!supported.includes(route.thinking??'off')?supported[0]:route.thinking??'off';}
  return value;
}
export async function callConfiguredChat(route,body,{config,readConfig=async()=>JSON.parse(await readFile(onebotPath('openclaw.json'),'utf8')),getCredential=resolveProviderCredential,request=requestAiJson,officialRequest,signal,timeoutMs,proxyUrl,invokeCli=invokeCliStep}={}){
  config??=await readConfig();const separator=route.model.indexOf('/'),providerId=route.model.slice(0,separator),model=route.model.slice(separator+1),registry=config.models?.providers?.[providerId];
  const registered=route.ai?.provider??Object.values(loadAiConfig().providers).find(p=>p.registryId===providerId);
  if(registered?.adapter===CLI_ADAPTER){
    const result=await invokeCli({taskId:route.taskId,deployment:{model},parameters:{...route.parameters,
      ...(body.response_format?.type==='json_object'?{responseFormat:'json'}:{})},thinking:route.thinking,
      input:{messages:body.messages},signal:route.signal??signal,timeoutMs:Math.min(timeoutMs??30000,route.timeoutMs??Infinity)});
    return {choices:[{finish_reason:'stop',message:{content:result.text}}],usage:result.usage};
  }
  const provider=route.ai?{baseUrl:registered.baseUrl,apiKey:registered.credential,headers:registered.headers,models:registry?.models}:registry??(registered?{baseUrl:registered.baseUrl,apiKey:registered.credential,headers:registered.headers}:null);
  if(!provider?.baseUrl)throw new AiError('configuration_error');
  const key=route.ai?.provider.credential?.source==='path'?await credentialFor(route.ai.provider,{config}):await getCredential(config,provider);if(!key)throw new AiError('authentication_error');signal?.throwIfAborted();
  const adapter=registered?.adapter??(provider.api==='openai-responses'?'openai-responses':'openai-chat');
  const chat=compatibleChatBody(config,route,body);
  const shaped=requestShape({provider:{...registered,adapter,baseUrl:provider.baseUrl},deployment:{model,compat:route.ai?.deployment.compat??provider.models?.find(x=>x.id===model)?.compat},parameters:{...route.parameters,maxOutputTokens:chat.max_tokens,temperature:chat.temperature,responseFormat:(body.response_format?.type==='json_object'?'json':undefined)},thinking:route.thinking,input:{messages:body.messages}});
  const invoke=officialRequest&&registered?.transport?.mode==='proxy'?officialRequest:request;
  const raw=await invoke(shaped.url,{apiKey:key,body:shaped.body,headers:provider.headers,signal:route.signal??signal,timeoutMs:Math.min(timeoutMs??route.timeoutMs??30000,route.timeoutMs??Infinity),transport:{...registered?.transport,...(proxyUrl?{mode:'proxy',proxyUrl}:{})},authHeader:registered?.authHeader,authPrefix:registered?.authPrefix});
  if(adapter!=='openai-chat')return {choices:[{finish_reason:'stop',message:{content:decodeText(raw,adapter)}}],usage:raw.usage};
  return raw;
}
export function completionText(result){return decodeText(result,'openai-chat');}
