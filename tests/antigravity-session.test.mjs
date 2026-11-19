import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {CliSessionStore} from '../src/src/ai/antigravity-sessions.js';
import {withCliCapacity} from '../src/src/ai/antigravity-capacity.js';

test('member and account isolation, late completions, recoveries and visible delivery',async t=>{
    const root=await mkdtemp(join(tmpdir(),'onebot-claims-')),file=join(root,'sessions.db');
    const a=new CliSessionStore(file),b=new CliSessionStore(file);
    t.after(async()=>{a.close();b.close();await rm(root,{recursive:true,force:true});});
    const first=a.acquire('stream-A','role-account-generation','m1',5000);
    assert.throws(()=>b.acquire('stream-A','role-account-generation','other',5000),{kind:'rate_limited'});
    const other=b.acquire('stream-B','role-account-generation','m1',5000);
    assert.equal(other.nativeId,undefined);
    a.finish('stream-A',first.token,'native-A','candidate');
    b.delivered('stream-A','m1','rewritten'); // platform text differs
    const second=b.acquire('stream-A','role-account-generation','m2',5000);
    assert.equal(second.nativeId,undefined);
    a.finish('stream-A',second.token,'native-A2','confirmed');b.delivered('stream-A','m2','confirmed');
    const third=b.acquire('stream-A','role-account-generation','m3',5000);assert.equal(third.nativeId,'native-A2');
    a.reset('stream-A');assert.throws(()=>b.finish('stream-A',third.token,'obsolete','late'),{kind:'cancelled'});
    assert.equal(a.acquire('stream-A','new-generation','m4',5000).nativeId,undefined);
    b.finish('stream-B',other.token,'native-B','independent',{receiptRequired:false});
    assert.equal(a.acquire('stream-B','different-account','m2',5000).nativeId,undefined);
});

test('resume the receipted public reply when the native candidate ends in a single complete QQ summary',async t=>{
    const root=await mkdtemp(join(tmpdir(),'onebot-public-receipt-'));
    const db=new CliSessionStore(join(root,'sessions.db'));
    t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
    const start='[[OPENCLAW_CONTEXT_SUMMARY]]',end='[[/OPENCLAW_CONTEXT_SUMMARY]]';
    const trailer='\n\n'+start+'\nprivate summary\n'+end;
    for(const [candidate,delivered,canResume] of [
        ['public reply'+trailer,'public reply',true],
        ['public reply'+trailer,'rewritten',false],
        ['public reply'+trailer,'',false],
        ['public reply\n'+start+'\npartial','public reply',false],
        ['public reply'+trailer+' trailing content','public reply',false],
        ['public reply'+trailer+trailer,'public reply'+trailer,false],
    ]){
        db.reset('chat');
        const first=db.acquire('chat','revision','r1',1000);
        db.finish('chat',first.token,'native-1',candidate);
        if(delivered)db.delivered('chat','r1',delivered);
        assert.equal(db.acquire('chat','revision','r2',1000).nativeId,canResume?'native-1':undefined);
    }
});

test('queued text tasks cannot consume the reviewer slot and deadlines include waiting',async t=>{
    const root=await mkdtemp(join(tmpdir(),'onebot-slots-')),options={file:join(root,'slots.db')};
    t.after(()=>rm(root,{recursive:true,force:true}));
    const releases=[];
    const wait=()=>new Promise(resolve=>releases.push(resolve));
    const running=[withCliCapacity('task',undefined,1000,wait,options),withCliCapacity('task',undefined,1000,wait,options)];
    try{
        assert.equal(await withCliCapacity('review',undefined,500,async()=>42,options),42);
        await assert.rejects(withCliCapacity('task',undefined,120,()=>assert.fail(),options),{kind:'timeout'});
        const controller=new AbortController();
        const cancelled=withCliCapacity('task',controller.signal,1000,()=>assert.fail(),options);
        controller.abort();await assert.rejects(cancelled,{kind:'cancelled'});
    }finally{releases.forEach(fn=>fn());await Promise.all(running);}
});
