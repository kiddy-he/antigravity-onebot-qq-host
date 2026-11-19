import {onebotPath as publicPath} from '../src/src/paths.js';
/** Trusted task-only bridge for local skills. No model, URL or key overrides. */
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {loadAiConfig} from '../src/src/ai/config.js';
import {taskPlan,AiError} from '../src/src/ai/router.js';
import {runAiTask} from '../src/src/ai/client.js';
export function nativeChatBody(input){return {messages:[...(input.systemInstruction?.parts?[{role:'system',content:input.systemInstruction.parts.map(p=>p.text??'').join('\n')}]:[]),...(input.contents??[]).map(item=>({role:item.role==='model'?'assistant':'user',content:(item.parts??[]).map(part=>{const image=part.inline_data??part.inlineData;return image?{type:'image_url',image_url:{url:`data:${image.mime_type??image.mimeType};base64,${image.data}`}}:{type:'text',text:part.text??''};})}))]};}
export const parseJson=text=>JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gu,''));
export function validateAssessment(decoded,schema,context={}){
  if(schema==='image-prompt'){if(typeof decoded!=='string'||decoded.trim().length<20||decoded.length>20000||/<think|\[CQ:|(?:sk|rk)-[A-Za-z0-9_-]{12,}/u.test(decoded))throw new AiError('validation_failed');return decoded;}
  if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw new AiError('validation_failed');
  if(!schema)return decoded;
  const schemas={
    'qzone-time':['qzone-ops/scripts/qzone-draft.py','verify_time_evidence'],
    'qzone-draft':['qzone-ops/scripts/qzone-draft.py','validate_payload'],
    'qzone-comment':['qzone-ops/scripts/qzone-patrol-model.py','validate_payload'],
    'image-quality':['agy-proxy/scripts/image-quality.py','evaluate'],
  };
  if(schema==='image-reference'){if(decoded?.action!=='generate'||typeof decoded.prompt!=='string'||!decoded.prompt.trim())throw new AiError('validation_failed');return decoded;}
  if(!schemas[schema])throw new AiError('configuration_error','Unknown trusted validator');
  const [relative,method]=schemas[schema];
  const script='import importlib.util,json,sys; s=importlib.util.spec_from_file_location("assessment",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); data=json.load(sys.stdin); getattr(m,sys.argv[2])(*data)';
  const args=schema==='qzone-draft'?[decoded,context]:[decoded];
  const result=spawnSync('/usr/bin/python3.12',['-c',script,publicPath("workspace/skills/")+relative,method],{input:JSON.stringify(args),encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  if(result.status!==0)throw new AiError('validation_failed','Invalid assessment evidence');return decoded;
}
export function resolveTask(taskId,config=loadAiConfig(),{profile}={}){
  const plan=taskPlan(config,taskId,{profile});return {taskId,revision:plan.revision,budgetMs:plan.route.budgetMs,routeId:plan.routeId,steps:plan.steps.map(s=>({deploymentId:s.deploymentId,adapter:s.provider.adapter,model:s.deployment.model,timeoutMs:s.timeoutMs,retry:s.retry,parameters:s.parameters,resources:s.deployment.resources})),workflows:config.workflows??{}};
}
export async function main(args=process.argv.slice(2)){
  const value=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
  try{
    const profile=value('--profile')??(process.env.ONEBOT_AI_PROFILE||undefined);
    if(profile&&!Object.hasOwn(loadAiConfig().profiles??{},profile))throw new AiError('configuration_error','Unknown AI profile');
    const taskId=value('--task');if(!taskId||args.includes('--model'))throw new AiError('invalid_request','Task ID required');
    if(args.includes('--resolve')){console.log(JSON.stringify(resolveTask(taskId,loadAiConfig(),{profile})));return;}
    const input=JSON.parse(readFileSync(0,'utf8')),native=args.includes('--native'),schema=value('--schema');
    const payload=native?nativeChatBody(input):input;
    const result=await runAiTask(taskId,{context:{aiProfile:profile},input:payload,validate:schema?text=>validateAssessment(schema==='image-prompt'?text:parseJson(text),schema,input.validationContext):undefined});
    const text=result.text,meta={onebot_model:result.model,onebot_provider:result.providerId,revision:result.revision};
    console.log(JSON.stringify(native?{candidates:[{content:{parts:[{text}]},finishReason:'STOP'}],...meta}:args.includes('--chat')?{choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}],...meta}:{...meta,text}));
  }catch(error){console.error(JSON.stringify({ok:false,error:error.kind??'task_unavailable'}));process.exitCode=error.kind==='policy_blocked'?42:1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
