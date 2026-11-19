import {projectSubscriptionHost} from './antigravity-config.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {onebotPath} from '../paths.js';
import {createConfigStore,taskPlan,AiError} from './router.js';
export const AI_CONFIG_PATH=process.env.ONEBOT_AI_CONFIG??onebotPath('onebot-ai.json');
const store=createConfigStore(AI_CONFIG_PATH);let synced;const snapshots=new AsyncLocalStorage();
export function loadAiConfig(){return snapshots.getStore()??store.snapshot();}
export const withAiSnapshot=fn=>snapshots.run(loadAiConfig(),fn);
export function configuredTaskRoutes(taskId,{profile,config=loadAiConfig(),metadata=false}={}){
  const plan=taskPlan(config,taskId,{profile,metadata});return plan.steps.map(step=>({model:(step.provider.registryId??step.providerId)+'/'+step.deployment.model,thinking:step.parameters.thinking??step.thinking??step.deployment.thinking??'off',timeoutMs:step.timeoutMs,taskId,aiProfile:profile,deploymentId:step.deploymentId,revision:plan.revision,parameters:step.parameters,ai:step}));
}
export const firstTaskRoute=(task,options)=>configuredTaskRoutes(task,options)[0];
export function configuredConversationProfile(roleAgentId,{profile,config=loadAiConfig()}={}){
  return config.bindings?.conversationProfiles?.[roleAgentId]?.[profile??'normal']??profile;
}
/** Compatibility registry is generated, not an independently edited source of model selection. */
export function syncAiRegistry(config=loadAiConfig()){
  if(synced===config)return false;const path=config.registry?.path;if(!path){synced=config;return false;}
  const current=configuredAgentConfig(JSON.parse(readFileSync(path,'utf8')),config);
  const text=JSON.stringify(current,null,2)+'\n';
  if(text!==readFileSync(path,'utf8')){const tmp=path+'.ai-'+process.pid;writeFileSync(tmp,text,{mode:0o600});renameSync(tmp,path);chmodSync(path,0o600);}
  synced=config;return true;
}
function hostParameters(parameters={},previous={}){
  const value={...previous};
  for(const key of ['maxTokens','temperature','topP','extraBody','extra_body','reasoningEffort'])delete value[key];
  if(parameters.maxOutputTokens!==undefined)value.maxTokens=parameters.maxOutputTokens;
  if(parameters.temperature!==undefined)value.temperature=parameters.temperature;
  if(parameters.topP!==undefined)value.topP=parameters.topP;
  if(parameters.extra)value.extraBody=structuredClone(parameters.extra);
  return value;
}
function hostRouteParameters(route,previous){
  const parameters=hostParameters(route.parameters,previous);
  // Native Anthropic derives adaptive thinking from its model metadata.
  // Its vendor extras must not follow the agent into an OpenAI fallback.
  if(route.ai.provider.adapter==='anthropic-messages')delete parameters.extraBody;
  return parameters;
}
export function configuredAgentConfig(source,config=loadAiConfig(),override={}){
  const current=structuredClone(source);current.models??={};current.models.providers??={};
  projectSubscriptionHost(current,config);
  for(const [id,p] of Object.entries(config.providers)){
    if(!p.registryId||!['openai-chat','openai-responses','anthropic-messages','gemini-native'].includes(p.adapter))continue;
    const old=current.models.providers[p.registryId]??{},models=Object.entries(config.deployments).filter(([,dep])=>dep.provider===id).map(([,dep])=>{
      const existing=old.models?.find(x=>x.id===dep.model)??{};
      return {...existing,id:dep.model,name:existing.name??dep.model,input:dep.capabilities.includes('vision')?['text','image']:['text'],contextWindow:dep.limits?.contextTokens??existing.contextWindow,maxTokens:dep.limits?.maxOutputTokens??existing.maxTokens,...(p.adapter==='anthropic-messages'&&(dep.parameters?.thinking??dep.thinking)?{reasoning:(dep.parameters?.thinking??dep.thinking)!=='off'}:{}),...(dep.compat?{compat:dep.compat}:{})};
    }).filter((x,i,a)=>a.findIndex(y=>y.id===x.id)===i);
    let reference=p.credential;if(reference?.source==='path'){current.secrets??={};current.secrets.providers??={};const secretId='ai-'+id;current.secrets.providers[secretId]={source:'file',path:reference.path,mode:'singleValue'};reference={source:'file',provider:secretId,id:'value'};}
    if(reference?.source==='env'){const secretId='ai-env';current.secrets??={};current.secrets.providers??={};const name=reference.name??reference.id;const existing=current.secrets.providers[secretId]?.allowlist??[];current.secrets.providers[secretId]={source:'env',allowlist:[...new Set([...existing,name])]};reference={source:'env',provider:secretId,id:name};}
    current.models.providers[p.registryId]={...old,baseUrl:p.baseUrl,api:({'openai-chat':'openai-completions','openai-responses':'openai-responses','anthropic-messages':'anthropic-messages','gemini-native':'google-generative-ai'})[p.adapter],apiKey:reference,headers:p.headers??{},models};
  }
  const main=firstTaskRoute('chat.reply',{config});current.agents??={};current.agents.defaults??={};current.agents.defaults.params=hostParameters(main.parameters,current.agents.defaults.params);current.agents.defaults.model={primary:main.model,fallbacks:configuredTaskRoutes('chat.reply',{config}).slice(1).map(x=>x.model)};
  for(const [agentId,binding] of Object.entries(config.bindings?.agents??{})){const entry=current.agents.entries?.[agentId];if(entry){const route=firstTaskRoute(binding.task,{config,profile:binding.profile});entry.params=hostRouteParameters(route,entry.params);entry.model={primary:route.model,fallbacks:configuredTaskRoutes(binding.task,{config,profile:binding.profile}).slice(1).map(x=>x.model)};}}
  if(override.agentId&&override.taskId){
    const routes=configuredTaskRoutes(override.taskId,{config,profile:override.profile}),index=override.routeIndex??0;
    if(!Number.isInteger(index)||index<0||!routes[index])throw new AiError('configuration_error','Configured task route index unavailable');
    if(!current.agents.entries?.[override.agentId])throw new AiError('configuration_error','Configured recovery agent unavailable');
    const entry=current.agents.entries?.[override.agentId],route=routes[index];
    if(entry){entry.params=hostRouteParameters(route,entry.params);entry.model={primary:route.model,fallbacks:override.singleRoute?[]:routes.slice(index+1).map(x=>x.model)};}
  }
  const models=Object.values(config.deployments).filter(dep=>config.providers[dep.provider].registryId).map(dep=>(config.providers[dep.provider].registryId)+'/'+dep.model);
  current.agents.defaults.models??={};for(const dep of Object.values(config.deployments)){const provider=config.providers[dep.provider];if(!provider.registryId)continue;const label=provider.registryId+'/'+dep.model;current.agents.defaults.models[label]??={};current.agents.defaults.models[label].params=hostParameters({...provider.parameters,...dep.parameters},current.agents.defaults.models[label].params);if(provider.adapter==='anthropic-messages'&&(dep.parameters?.thinking??dep.thinking)!==undefined)current.agents.defaults.models[label].params.thinking=dep.parameters?.thinking??dep.thinking;}
  current.agents.defaults.modelPolicy??={};current.agents.defaults.modelPolicy.allow=[...new Set([...(current.agents.defaults.modelPolicy.allow??[]),...models])];
  current.agents.defaults.thinkingDefault=main.thinking;
  return current;
}
// Polling costs no network; invalid updates retain the last validated snapshot.
let watcher;
export function watchAiConfig(){if(watcher)return;syncAiRegistry();watcher=setInterval(()=>{try{syncAiRegistry();}catch{}},2000);watcher.unref();}
