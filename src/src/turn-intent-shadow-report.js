import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {onebotPath} from './paths.js';
const percentile=(values,q)=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*q)-1)]:null;};
export async function readIntentShadowSamples({dir=onebotPath('state','intent-shadow'),days=14,now=Date.now(),includeVerification=false}={}){
    let files;try{files=await readdir(dir);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    const records=[];for(const name of files.sort()){
        if(!/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name)||Date.parse(name.slice(0,10)+'T00:00:00Z')+86400000<now-days*86400000)continue;
        const text=await readFile(join(dir,name),'utf8');for(const line of text.split('\n')){if(!line.trim())continue;try{const r=JSON.parse(line);if(r.mode==='normal'&&(r.source==='live'||includeVerification)&&Date.parse(r.at)>=now-days*86400000)records.push(r);}catch{/* Ignore an interrupted final write. */}}
    }return records;
}
export function summarizeIntentShadow(records){
    const good=records.filter(r=>r.shadow?.ok),paired=good.filter(r=>r.primary?.ok),fieldDisagreements={},positiveCoverage={},failures={},models={};
    for(const r of records){const label=r.shadow?.model??'unavailable';models[label]=(models[label]??0)+1;if(!r.shadow?.ok)failures[r.shadow?.error??'unknown']=(failures[r.shadow?.error??'unknown']??0)+1;}
    for(const r of paired){for(const field of Object.keys(r.differences??{}))fieldDisagreements[field]=(fieldDisagreements[field]??0)+1;
        for(const[field,value]of Object.entries(r.primary.result??{})){if(value!==false&&value!==null&&!['none','text','continue','unknown'].includes(value)){const label=field+'='+value;positiveCoverage[label]=(positiveCoverage[label]??0)+1;}}}
    return {samples:records.length,shadowSuccess:good.length,paired:paired.length,exactAgreement:paired.filter(r=>Object.keys(r.differences??{}).length===0).length,
        latencyMs:{primaryP50:percentile(paired.map(r=>r.primary.elapsedMs),.5),primaryP95:percentile(paired.map(r=>r.primary.elapsedMs),.95),shadowP50:percentile(good.map(r=>r.shadow.elapsedMs),.5),shadowP95:percentile(good.map(r=>r.shadow.elapsedMs),.95)},
        failures,models,fieldDisagreements,primaryPositiveCoverage:positiveCoverage,
        confidence:Object.fromEntries([.7,.8,.9].map(t=>[t,{accepted:good.filter(r=>r.shadow.minConfidence>=t&&!r.shadow.violations?.length).length,total:good.length}])),
        note:'Agreement is not accuracy. Verification samples are excluded by default; no raw messages or identities are included.'};
}
