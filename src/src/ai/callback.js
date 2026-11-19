/** Run a host-agent/local callback with the same task budget and retry policy as HTTP calls. */
import {loadAiConfig} from './config.js';
import {createAiRouter,taskPlan} from './router.js';
export async function runTaskCallback(taskId,invoke,{getConfig=loadAiConfig,profile,input={},signal,timeoutMs,firstOnly=false}={}){
  let config=getConfig();
  if(firstOnly){const plan=taskPlan(config,taskId,{profile});config={...config,routes:{...config.routes,[plan.routeId]:{...plan.route,steps:plan.route.steps.slice(0,1)}}};}
  const router=createAiRouter({getConfig:()=>config,invoke:async step=>({text:'completed',value:await invoke({
    model:(step.provider.registryId??step.providerId)+'/'+step.deployment.model,
    thinking:step.parameters.thinking??step.thinking??step.deployment.thinking??'off',parameters:step.parameters,
    timeoutMs:step.timeoutMs,taskId,aiProfile:profile,ai:step,signal:step.signal,input:step.input,
  })})});
  return (await router.run(taskId,{input,signal,timeoutMs,context:{aiProfile:profile}})).value;
}
