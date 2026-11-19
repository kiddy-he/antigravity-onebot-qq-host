import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {nextOccurrence,Schedules} from '../src/src/standalone/schedules.js';

test('imports deadlines from host SQL, preserves disabled and in-flight jobs, and never replays a claimed tick',async t=>{
    const dir=await mkdtemp(join(tmpdir(),'onebot-schedule-')),file=join(dir,'work.sqlite'),host=join(dir,'source.sqlite');
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const input=new DatabaseSync(host);
    input.exec('CREATE TABLE cron_jobs(store_key TEXT,job_id TEXT,job_json TEXT,state_json TEXT,next_run_at_ms INTEGER,running_at_ms INTEGER,last_run_at_ms INTEGER)');
    const put=(id,enabled,due,running,schedule={kind:'every',everyMs:1000,anchorMs:50})=>input.prepare("INSERT INTO cron_jobs VALUES ('/fixture/jobs.json',?,?,?, ?,?,NULL)")
        .run(id,JSON.stringify({id,enabled,schedule,payload:{kind:'command'}}),JSON.stringify({lastDurationMs:123}),due,running);
    put('active',true,1050,null);put('paused',false,null,null);put('started',true,1050,1060);
    put('once',true,1080,null,{kind:'at',at:new Date(1080).toISOString()});
    input.close();
    const a=new Schedules(file),b=new Schedules(file);
    try{
        assert.throws(()=>a.importHost(host,1100,'/wrong/jobs.json'),/partition is absent/u);
        assert.equal(a.importHost(host,1100),4);assert.equal(b.importHost(host,1100),0);
        assert.equal(a.get('paused').enabled,false);
        assert.equal(a.get('active').state.lastDurationMs,123);
        a.put({...a.get('active'),name:'renamed'},1110);
        assert.equal(a.list().find(j=>j.id==='active').state.nextRunAtMs,1050);
        assert.equal(a.db.prepare("SELECT status FROM occurrences WHERE job='started'").get().status,'uncertain');
        const one=a.claim(1100);assert.equal(one.job.id,'active');
        const two=b.claim(1100);assert.equal(two.job.id,'once');
        assert.equal(b.claim(1100),undefined);a.finish(one,'completed');b.finish(two,'failed','fixture failure');
        assert.equal(a.claim(2049),undefined);
        const next=b.claim(2050);assert.equal(next.slot,2050);
        const changed=new DatabaseSync(host);
        try{changed.exec("UPDATE cron_jobs SET next_run_at_ms=9090 WHERE job_id='active'");}finally{changed.close();}
        assert.throws(()=>a.importHost(host,2100),/Legacy scheduler changed/u);
        assert.notEqual(a.list().find(job=>job.id==='active').state.nextRunAtMs,9090);
    }finally{a.close();b.close();}
});

test('cron time zone, interval anchors and one-off times',()=>{
    assert.equal(new Date(nextOccurrence({kind:'cron',expr:'30 20 * * 1,2,4',tz:'Asia/Shanghai'},Date.parse('2026-11-19T10:00:00Z'))).toISOString(),'2026-11-19T12:30:00.000Z');
    assert.equal(nextOccurrence({kind:'every',everyMs:1000,anchorMs:1250},0),1250);
    assert.equal(nextOccurrence({kind:'at',at:'2026-11-19T10:00:00Z'},Date.parse('2026-11-19T10:01:00Z')),null);
});
