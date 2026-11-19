import {appendFile,chmod,mkdir,readdir,readFile,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {loadAiConfig} from './ai/config.js';
import {taskClient} from './ai/client.js';
import {errorKind} from './ai/router.js';
import {onebotPath} from './paths.js';
import {INTENT_DECISION_QUESTIONS,INTENT_DECISION_POLICY_HASH,parseIntentDecisions,intentFields} from './turn-intent-decisions.js';

export const INTENT_SHADOW_TASK='inbound.intent.shadow';
const limits={maxConcurrent:[1,4,2],maxPerMinute:[1,100,8],maxPerDay:[1,10000,1000],retentionDays:[1,90,14],maxDailyBytes:[4096,104857600,20971520]};
export function intentShadowSettings(config){
    const raw=config.extensions?.inboundIntentShadow;
    if(raw?.enabled!==true||!config.enabled||config.tasks?.[INTENT_SHADOW_TASK]?.enabled!==true)return null;
    if(Object.keys(raw).some(k=>!['enabled','sampleRate',...Object.keys(limits)].includes(k)))return null;
    const sampleRate=raw.sampleRate??1;if(!Number.isFinite(sampleRate)||sampleRate<0||sampleRate>1)return null;
    const result={sampleRate};
    for(const[k,[min,max,fallback]]of Object.entries(limits)){const v=raw[k]??fallback;if(!Number.isSafeInteger(v)||v<min||v>max)return null;result[k]=v;}
    return result;
}
export function redactIntentShadowText(value){
    return String(value??'')
        .replace(/\b(?:sk-|AQ\.)[A-Za-z0-9_.-]{12,}/gu,'[REDACTED_KEY]')
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/giu,'$1[REDACTED]')
        .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/giu,'$1[REDACTED]')
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu,'[REDACTED_EMAIL]')
        .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.[\d.]+|10\.[\d.]+)(?::\d+)?[^\s"']*/giu,'https://internal.example.invalid')
        .replace(/\b\d{5,20}\b/gu,'700000001');
}
function statusError(error){const kind=errorKind(error);return ['timeout','network_error','rate_limited','upstream_5xx','invalid_schema','validation_failed','invalid_request','authentication_error','configuration_error','disabled','policy_blocked','cancelled'].includes(kind)?kind:'failed';}
export function createIntentShadowCollector({getConfig=loadAiConfig,run,dir=onebotPath('state','intent-shadow'),now=Date.now,random=Math.random}={}){
    let pending=0,day='',dailyCount=0,minute=[],keyPromise,writeTail=Promise.resolve(),lastCleanup=0;
    const counts={scheduled:0,ok:0,failed:0,skipped:{}};
    const skip=reason=>{counts.skipped[reason]=(counts.skipped[reason]??0)+1;return null;};
    async function identityKey(){
        if(!keyPromise)keyPromise=(async()=>{await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);const path=join(dir,'.identity-key');try{await writeFile(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}const key=await readFile(path);if(key.length!==32)throw Error('Invalid local identity key');return key;})();
        return keyPromise;
    }
    async function reserveDaily(date,settings){
        const operation=writeTail.then(async()=>{
            await identityKey();const path=join(dir,'.budget.json');let budget={date,count:0};
            try{const old=JSON.parse(await readFile(path,'utf8'));if(old.date===date){if(!Number.isSafeInteger(old.count)||old.count<0)throw Error('Invalid local budget');budget=old;}}catch(e){if(e.code!=='ENOENT')throw e;}
            if(budget.count>=settings.maxPerDay)return false;
            const temporary=path+'.'+process.pid+'.tmp';await writeFile(temporary,JSON.stringify({date,count:budget.count+1})+'\n',{mode:0o600});await rename(temporary,path);return true;
        });
        writeTail=operation.catch(()=>{});return operation;
    }
    async function store(record,settings){
        const operation=writeTail.then(async()=>{
            const key=await identityKey();
            const digest=value=>createHmac('sha256',key).update(String(value??'')).digest('hex').slice(0,24);
            record.requestHash=digest(record.requestId);record.sessionHash=digest(record.sessionKey);delete record.requestId;delete record.sessionKey;
            const file=join(dir,record.at.slice(0,10)+'.jsonl'),line=JSON.stringify(record)+'\n';let size=0;try{size=(await stat(file)).size;}catch(e){if(e.code!=='ENOENT')throw e;}
            if(size+Buffer.byteLength(line)>settings.maxDailyBytes){skip('storage-limit');return;}
            await appendFile(file,line,{mode:0o600});await chmod(file,0o600);
            if(now()-lastCleanup>3600000){
                lastCleanup=now();const cutoff=now()-settings.retentionDays*86400000;
                for(const name of await readdir(dir)){if(!/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))continue;const date=Date.parse(name.slice(0,10)+'T00:00:00Z');if(date+86400000<=cutoff)await unlink(join(dir,name));}
            }
        });
        writeTail=operation.catch(()=>{});return operation;
    }
    function observe({text,hasInboundImage=false,recentContext='',mode,requestId,sessionKey,scope,actor,role,primary,log,source='live'}={}){
        // No unknown/isolated session may reach either the remote model or local samples.
        if(mode!=='normal'||typeof sessionKey!=='string'||!sessionKey||/(?:nsfw|isolated)/iu.test(sessionKey))return skip('mode');
        if(!String(text??'').trim()||!primary)return skip('input');
        let config,settings;try{config=getConfig();settings=intentShadowSettings(config);}catch{return skip('configuration');}
        if(!settings)return skip('disabled');
        if(random()>=settings.sampleRate)return skip('sampling');
        const t=now(),date=new Date(t).toISOString().slice(0,10);if(day!==date){day=date;dailyCount=0;}
        minute=minute.filter(at=>t-at<60000);
        if(pending>=settings.maxConcurrent)return skip('concurrency');
        if(minute.length>=settings.maxPerMinute)return skip('rate-limit');
        if(dailyCount>=settings.maxPerDay)return skip('daily-limit');
        pending++;dailyCount++;minute.push(t);counts.scheduled++;
        const input={message:redactIntentShadowText(String(text).slice(0,12000)),has_inbound_image:Boolean(hasInboundImage),recent_context:redactIntentShadowText(String(recentContext).slice(-4000))};
        // Observe rejection immediately even if the network request has not finished.
        const primaryResult=Promise.resolve(primary).then(value=>({ok:true,...value}),()=>({ok:false,error:'primary-failed'}));
        const started=performance.now();
        const work=(async()=>{
            if(!await reserveDaily(date,settings)){skip('daily-limit');return null;}
            const record={schemaVersion:1,id:randomUUID(),at:new Date(t).toISOString(),source,mode:'normal',scope:['group','private'].includes(scope)?scope:'unknown',actor:actor==='admin'?'admin':'guest',role:['main','onebot-yuexia'].includes(role)?role:'other',requestId,sessionKey,configRevision:config.revision,policyHash:INTENT_DECISION_POLICY_HASH,input,inputRedacted:true,contextStatus:'captured-at-classification'};
            let parsed;
            try{
                const output=await (run??((task,options)=>taskClient({getConfig:()=>config}).run(task,options)))(INTENT_SHADOW_TASK,{
                    input:{input:JSON.stringify(input),questions:INTENT_DECISION_QUESTIONS},
                    validate:value=>{parsed=parseIntentDecisions(value);},
                });
                // An injected or future client must satisfy the same contract.
                parsed??=parseIntentDecisions(output.text);
                record.shadow={ok:true,model:output.providerId+'/'+output.model,elapsedMs:Math.round(performance.now()-started),result:intentFields(parsed.result),rawValues:parsed.rawValues,confidence:parsed.confidence,minConfidence:parsed.minConfidence,violations:parsed.violations,usage:output.usage};counts.ok++;
            }catch(error){record.shadow={ok:false,error:statusError(error),elapsedMs:Math.round(performance.now()-started)};counts.failed++;}
            let waitTimer;
            const expired=new Promise(resolve=>{waitTimer=setTimeout(()=>resolve({ok:false,error:'primary-unavailable'}),90000);waitTimer.unref?.();});
            const production=await Promise.race([primaryResult,expired]);clearTimeout(waitTimer);
            record.primary={ok:production.ok&&Boolean(production.result)&&production.result.speechMode!=='unknown',model:production.model??'unknown',elapsedMs:production.elapsedMs??null,result:intentFields(production.result)};
            record.differences=record.shadow.ok?Object.fromEntries(Object.entries(record.primary.result).filter(([field,value])=>record.shadow.result[field]!==value).map(([field,value])=>[field,{primary:value,shadow:record.shadow.result[field]}])):null;
            try{await store(record,settings);log?.info?.(`[onebot] Intent shadow status=${record.shadow.ok?'ok':record.shadow.error} ms=${record.shadow.elapsedMs} differences=${record.differences?Object.keys(record.differences).join(',')||'none':'unavailable'}`);}catch{log?.warn?.('[onebot] Intent shadow sample write failed');}
            return record;
        })().catch(()=>{log?.warn?.('[onebot] Intent shadow observation failed');return null;}).finally(()=>{pending--;});
        return work;
    }
    return {observe,stats:()=>structuredClone({...counts,pending})};
}
const collector=createIntentShadowCollector();
export const observeTurnIntentShadow=input=>collector.observe(input);
export const intentShadowStats=()=>collector.stats();
