/** Fixed skill HTTP bridge: configuration-owned deadlines and routes. */
import {loadAiConfig} from '../src/src/ai/config.js';
import {referenceNetworkSettings,fetchReference} from '../src/src/features/reference-network.js';
const [source,...args]=process.argv.slice(2);
try{
 const settings=referenceNetworkSettings(loadAiConfig());
 const deadline=Math.min(...['AGY_REFERENCE_SOURCE_DEADLINE_MS','AGY_REFERENCE_DEADLINE_MS'].map(k=>Number(process.env[k])||Infinity));
 const result=await fetchReference({source,args,settings,deadline,stateFile:process.env.AGY_REFERENCE_NETWORK_STATE,
  onEvent:e=>console.error(`reference_transport=${JSON.stringify(e)}`)});
 if(result.ok){if(result.body)process.stdout.write(result.body);}else{console.error(`reference_reason=${result.reason}`);process.exitCode=1;}
}catch{console.error('reference_reason=reference_network_configuration');process.exitCode=1;}
