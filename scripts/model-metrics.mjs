#!/usr/bin/env node
import {createReadStream} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {onebotPath} from '../src/src/paths.js';

function distribution(values){
    const sorted=values.toSorted((a,b)=>a-b);
    const quantile=p=>sorted.length?sorted[Math.ceil(p*sorted.length)-1]:null;
    return {n:sorted.length,p50:quantile(.5),p95:quantile(.95)};
}

export function summarizeMetrics(events,since,until){
    const turns=new Map();
    for(const event of events){
        if(!event.turn||event.at>until)continue;
        if(!turns.has(event.turn))turns.set(event.turn,[]);
        turns.get(event.turn).push(event);
    }
    const classes=['private','group','dual-role','image','search','review','approval','agentTurn','command','heartbeat'];
    const samples=Object.fromEntries(classes.map(name=>[name,[]]));
    for(const events of turns.values()){
        const starts=events.filter(e=>e.event==='start');
        if(!starts.length)continue;
        const start=Math.min(...starts.map(e=>e.receivedAt));
        if(start<since||start>until)continue;
        const kinds=new Set(starts.map(e=>e.kind));
        if(starts.some(e=>e.hasImage))kinds.add('image');
        if(events.some(e=>e.event==='dual-role'))kinds.add('dual-role');
        if(events.some(e=>e.event==='native-session'&&e.search))kinds.add('search');
        if(events.some(e=>e.event==='attempt'&&e.taskId?.startsWith('approval.reviewer.')))kinds.add('approval');
        if(events.some(e=>e.event==='attempt'&&/review/u.test(e.taskId)))kinds.add('review');
        const receipts=events.filter(e=>e.event==='receipt');
        const uniqueReceipts=new Set(receipts.map(e=>JSON.stringify([e.account,e.platform])));
        const ends=events.filter(e=>e.event==='end');
        const finished=starts.every(s=>ends.some(e=>e.span===s.span));
        const row={first:receipts.length?Math.max(0,Math.min(...receipts.map(e=>e.at))-start):null,
            full:finished?Math.max(0,Math.max(...ends.map(e=>e.at))-start):null,
            hadModel:events.some(e=>e.event==='attempt'||e.event==='cli-start'),parts:uniqueReceipts.size,deliveries:new Set(receipts.map(e=>e.deliveryId).filter(Boolean)).size,
            searchCalls:events.filter(e=>e.event==='native-search'&&e.completed).length,
            failedWaits:events.filter(e=>e.event==='capacity'&&e.acquired===false).length,
            cli:events.filter(e=>e.event==='cli-start').length,
            waits:events.filter(e=>e.event==='capacity').map(e=>e.waitMs),
            errors:events.filter(e=>e.event==='attempt'&&!e.ok),resumes:events.filter(e=>e.event==='native-session'&&e.resumed).length};
        for(const kind of kinds)if(samples[kind])samples[kind].push(row);
    }
    return Object.fromEntries(Object.entries(samples).map(([kind,rows])=>{
        const delivered=rows.filter(r=>r.first!==null),complete=rows.filter(r=>r.full!==null);
        const reasons={};
        for(const row of rows)for(const e of row.errors){
            const key=[e.provider,e.kind,e.next].join('/');
            reasons[key]=(reasons[key]??0)+1;
        }
        return [kind,{started:rows.length,withModelActivity:rows.filter(r=>r.hadModel).length,completed:complete.length,delivered:delivered.length,
            platformParts:rows.reduce((sum,row)=>sum+row.parts,0),
            durableDeliveries:rows.reduce((sum,row)=>sum+row.deliveries,0),
            completedNativeSearches:rows.reduce((sum,row)=>sum+row.searchCalls,0),
            unsuccessfulCapacityWaits:rows.reduce((sum,row)=>sum+row.failedWaits,0),
            firstVisibleMs:distribution(delivered.map(r=>r.first)),fullMs:distribution(complete.map(r=>r.full)),
            cliStartsPerCompletedDeliveredTurn:distribution(delivered.filter(r=>r.full!==null).map(r=>r.cli)),
            capacityWaitMs:distribution(rows.flatMap(r=>r.waits)),nativeLoads:rows.reduce((sum,row)=>sum+row.resumes,0),
            errorsByProviderKindAndNext:reasons}];
    }));
}

async function main(args){
    const until=args[1]?Date.parse(args[1]):Date.now();
    const since=args[0]?Date.parse(args[0]):until-86400000;
    if(args.length>2||!Number.isFinite(since)||!Number.isFinite(until)||until<since)throw Error('Expected start and end ISO timestamps');
    const dir=onebotPath('state','antigravity','metrics'),events=[];
    const files=await readdir(dir).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    let incompleteLines=0;
    for(const file of files.sort()){
        if(!/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(file))continue;
        const day=Date.parse(file.slice(0,10)+'T00:00:00Z');
        if(day+86400000<=since||day>until)continue;
        for await(const line of createInterface({input:createReadStream(join(dir,file)),crlfDelay:Infinity})){
            try{events.push(JSON.parse(line));}catch{incompleteLines++;}
        }
    }
    console.log(JSON.stringify({since:new Date(since),until:new Date(until),incompleteLines,
        classes:summarizeMetrics(events,since,until)},null,2));
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main(process.argv.slice(2));
