/** Select only character pages and real image candidates returned by Baidu Baike. */
import {loadAiConfig} from '../src/src/ai/config.js';
import {referenceNetworkSettings,fetchReference} from '../src/src/features/reference-network.js';
import {parseBaiduPage,baiduLookupNames,baiduImageCandidates,planBaiduLookup} from '../src/src/features/baidu-reference.js';
import {runAiTask} from '../src/src/ai/client.js';
import {selectCharacterReference} from '../src/src/features/character-reference.js';
const [query,hint='']=process.argv.slice(2);
try{
 const aiProfile=process.env.ONEBOT_AI_PROFILE||undefined;
 const settings=referenceNetworkSettings(loadAiConfig());
 const deadline=Math.min(Date.now()+settings.sourceBudgetMs,...['AGY_REFERENCE_SOURCE_DEADLINE_MS','AGY_REFERENCE_DEADLINE_MS'].map(k=>Number(process.env[k])||Infinity));
 let reason='no_match';
 const proposed=hint?[]:await planBaiduLookup(query,{run:runAiTask,aiProfile,timeoutMs:Math.max(1,deadline-Date.now())});
 const names=[...new Set([...proposed,...baiduLookupNames(query,hint)])].slice(0,3);
 for(const name of names){
  if(Date.now()+100>=deadline){reason='reference_timeout';break;}
  const url=`https://wapbaike.baidu.com/item/${encodeURIComponent(name)}`;
  const response=await fetchReference({source:'baidu',settings,deadline,stateFile:process.env.AGY_REFERENCE_NETWORK_STATE,
   args:['--get','--user-agent','Mozilla/5.0',url],onEvent:e=>console.error(`reference_transport=${JSON.stringify(e)}`)});
  if(!response.ok){reason=response.reason;continue;}
  let page;try{page=parseBaiduPage(response.body.toString('utf8'),response.url);}catch(error){reason=error.message;continue;}
  const result=await selectCharacterReference({query,payload:{query:{pages:[page]}},aiProfile,timeoutMs:Math.max(1,deadline-Date.now())});
  if(result.status!=='selected'){reason=Date.now()>=deadline?'reference_timeout':result.status;continue;}
  const images=baiduImageCandidates(result.page,result.page.requested_variant);
  if(!images.length){reason='reference_image_unavailable';continue;}
  console.log(JSON.stringify({status:'selected',identity:result.page.title,page:result.page.fullurl,images}));
  process.exit(0);
 }
 console.error(`reference_reason=${reason}`);console.log('{"status":"failed"}');
}catch{console.error('reference_reason=search_invalid_response');console.log('{"status":"failed"}');}
