import {CLI_ADAPTER,invokeCliStep} from './antigravity-cli.js';
import {readFile} from 'node:fs/promises';
import {onebotPath} from '../paths.js';
import {resolveProviderCredential} from '../llm-credentials.js';
import {loadAiConfig} from './config.js';
import {createAiRouter,requestShape,decodeText,AiError} from './router.js';
import {requestAiJson} from './http.js';
export async function credentialFor(provider,{config,read=readFile}={}){
  const ref=provider.credential;if(ref?.source==='env')return process.env[ref.name??ref.id];if(ref?.source==='path')return String(await read(ref.path,'utf8')).trim();
  config??=JSON.parse(await read(onebotPath('openclaw.json'),'utf8'));
  return resolveProviderCredential(config,{apiKey:ref});
}
export async function invokeTaskStep(step,{request=requestAiJson,getCredential,config,registryOverrides=false,invokeCli=invokeCliStep}={}){
  if(step.provider.adapter===CLI_ADAPTER)return invokeCli(step);
  const registry=registryOverrides&&config?.models?.providers?.[step.provider.registryId??step.providerId];
  const effective=registry?{...step,provider:{...step.provider,baseUrl:registry.baseUrl,credential:registry.apiKey,headers:registry.headers??step.provider.headers}}:step;
  const {url,body}=requestShape(effective);
  const raw=await requestTaskBody(effective,url,body,{request,getCredential,config});
  return {text:decodeText(raw,step.provider.adapter),complete:true,raw,usage:raw.usage??raw.usageMetadata};
}
export async function requestTaskBody(step,url,body,{request=requestAiJson,getCredential,config}={}){
  const effective=step,apiKey=getCredential&&effective.provider.credential?.source!=='path'?await getCredential(config,{apiKey:effective.provider.credential}):await credentialFor(effective.provider,{config});
  if(!apiKey)throw new AiError('authentication_error');
  return request(url,{apiKey,body,signal:step.signal,timeoutMs:step.timeoutMs,headers:effective.provider.headers,transport:step.provider.transport,authHeader:step.provider.authHeader??(['gemini-native','gemini-decisions'].includes(step.provider.adapter)?'x-goog-api-key':step.provider.adapter==='anthropic-messages'?'x-api-key':undefined),authPrefix:step.provider.authPrefix??(['gemini-native','gemini-decisions','anthropic-messages'].includes(step.provider.adapter)?'':undefined)});
}
export function taskClient({getConfig=loadAiConfig,request,getCredential,config,validators,onEvent,invokeCli,registryOverrides=false}={}){
  return createAiRouter({getConfig,invoke:step=>invokeTaskStep(step,{request,getCredential,config,registryOverrides,invokeCli}),validators,onEvent});
}
export const runAiTask=(taskId,options={},dependencies={})=>taskClient(dependencies).run(taskId,options);
