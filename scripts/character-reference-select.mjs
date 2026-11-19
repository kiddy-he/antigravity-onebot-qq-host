/** Private skill bridge: reads encyclopedia data, returns a locally selected page. */
import {readFileSync} from 'node:fs';
import {selectCharacterReference} from '../src/src/features/character-reference.js';
try {
 const [query,file]=process.argv.slice(2);
 if(!query||query.length>500||!file)throw Error();
 const deadline=Math.min(...['AGY_REFERENCE_SOURCE_DEADLINE_MS','AGY_REFERENCE_DEADLINE_MS'].map(k=>Number(process.env[k])||Infinity));
 if(deadline<=Date.now()) {console.log('{"reference_status":"reference_timeout"}');process.exit(0);}
 const result=await selectCharacterReference({query,aiProfile:process.env.ONEBOT_AI_PROFILE || undefined,payload:JSON.parse(readFileSync(file,'utf8')),timeoutMs:Number.isFinite(deadline)?Math.max(1,deadline-Date.now()):undefined});
 console.log(JSON.stringify(result.status==='selected'?result.page:{reference_status:Date.now()>=deadline?'reference_timeout':result.status}));
} catch {console.log(JSON.stringify({reference_status:'search_invalid_response'}));}
