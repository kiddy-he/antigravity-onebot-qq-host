import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Cron} from 'croner';

export function nextOccurrence(schedule,now) {
    if(schedule.kind==='at'){
        const at=Date.parse(schedule.at);
        if(!Number.isFinite(at))throw Error('Invalid scheduled time');
        return at>now?at:null;
    }
    if(schedule.kind==='every'){
        const {everyMs,anchorMs=0}=schedule;
        if(!Number.isSafeInteger(everyMs)||everyMs<=0||!Number.isSafeInteger(anchorMs))throw Error('Invalid interval');
        return now<anchorMs?anchorMs:anchorMs+(Math.floor((now-anchorMs)/everyMs)+1)*everyMs;
    }
    if(schedule.kind!=='cron'||(schedule.staggerMs??0)!==0)throw Error('Unsupported schedule');
    return new Cron(schedule.expr,{timezone:schedule.tz??Intl.DateTimeFormat().resolvedOptions().timeZone})
        .nextRun(new Date(now))?.getTime()??null;
}

// The host keeps configuration and mutable runtime state in separate columns.
export function readHostScheduleRows(db,storeKey){
    const partitions=db.prepare('SELECT DISTINCT store_key FROM cron_jobs').all();
    if(!storeKey && partitions.length>1)throw Error('Select the configured cron partition');
    const key=storeKey??partitions[0]?.store_key;
    if(key && partitions.length && !partitions.some(row=>row.store_key===key))
        throw Error('Configured cron partition is absent from legacy scheduler');
    const rows=key?db.prepare('SELECT * FROM cron_jobs WHERE store_key=? ORDER BY job_id').all(key):[];
    const fingerprint=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    return {key,rows,fingerprint};
}

export class Schedules {
    constructor(file){
        mkdirSync(dirname(file),{recursive:true,mode:0o700});this.db=new DatabaseSync(file);
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,body TEXT NOT NULL,due INTEGER); CREATE TABLE IF NOT EXISTS occurrences(id TEXT PRIMARY KEY,job TEXT NOT NULL,slot INTEGER NOT NULL,status TEXT NOT NULL,detail TEXT,summary TEXT,model_info TEXT,UNIQUE(job,slot)); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT)');
        const columns=this.db.prepare('PRAGMA table_info(occurrences)').all().map(column=>column.name);
        for(const name of ['summary','model_info'])if(!columns.includes(name))this.db.exec('ALTER TABLE occurrences ADD COLUMN '+name+' TEXT');
    }
    pendingHostImport(file,storeKey){
        const imported=this.db.prepare("SELECT 1 FROM metadata WHERE key='host-import'").get();
        const old=new DatabaseSync(file,{readOnly:true});
        let snapshot;
        try{snapshot=readHostScheduleRows(old,storeKey);}finally{old.close();}
        const {key,fingerprint}=snapshot;
        if(imported){
            const prior=Object.fromEntries(this.db.prepare("SELECT key,value FROM metadata WHERE key IN ('host-partition','host-fingerprint')").all().map(r=>[r.key,r.value]));
            if((key??null)!==(prior['host-partition']??null) || (key && fingerprint!==prior['host-fingerprint']))
                throw Error('Legacy scheduler changed after handoff; reconcile the two scheduler histories before starting');
            return null;
        }
        if(this.db.prepare('SELECT 1 FROM jobs LIMIT 1').get())throw Error('Import requires empty scheduler');
        return snapshot;
    }
    importHost(file,now=Date.now(),storeKey){
        return this.importSnapshot(this.pendingHostImport(file,storeKey),now);
    }
    importSnapshot(snapshot,now=Date.now()){
        if(!snapshot)return 0;
        const {rows,key,fingerprint}=snapshot;
        this.db.exec('BEGIN IMMEDIATE');
        try{
            if(this.db.prepare('SELECT 1 FROM jobs LIMIT 1').get()) throw Error('Import requires empty scheduler');
            for(const row of rows){
                const job=JSON.parse(row.job_json);
                const due=job.enabled?(row.next_run_at_ms??nextOccurrence(job.schedule,now)):null;
                job.state={...job.state,...JSON.parse(row.state_json)};
                delete job.state.runningAtMs;delete job.state.nextRunAtMs;
                if(row.last_run_at_ms!=null)job.state.lastRunAtMs=row.last_run_at_ms;
                job.updatedAtMs=row.runtime_updated_at_ms??row.updated_at??job.updatedAtMs;
                if(row.running_at_ms && job.schedule.kind==='at')job.enabled=false;
                this.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(job.id,JSON.stringify(job),due);
                if(row.running_at_ms) {
                    const slot=due!=null?Math.min(due,row.running_at_ms):row.running_at_ms;
                    this.db.prepare('INSERT INTO occurrences(id,job,slot,status,detail) VALUES (?,?,?,?,?)').run(randomUUID(),job.id,slot,'uncertain','Imported running occurrence');
                    this.db.prepare('UPDATE jobs SET due=? WHERE id=?').run(job.enabled?(due>now?due:nextOccurrence(job.schedule,Math.max(slot,now))):null,job.id);
                }
            }
            this.db.prepare("INSERT INTO metadata VALUES ('host-import',?)").run(String(now));
            if(key)this.db.prepare("INSERT INTO metadata VALUES ('host-partition',?),('host-fingerprint',?)").run(key,fingerprint);
            this.db.exec('COMMIT');return rows.length;
        }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    list(){return this.db.prepare('SELECT body,due FROM jobs ORDER BY id').all().map(row=>{
        const job=JSON.parse(row.body);return {...job,state:{...job.state,nextRunAtMs:row.due??undefined}};
    });}
    get(id){const row=this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id);return row?JSON.parse(row.body):null;}
    put(job,now=Date.now()){
        if(!job.id||typeof job.enabled!=='boolean')throw Error('Invalid job');
        const prior=this.db.prepare('SELECT body,due FROM jobs WHERE id=?').get(job.id);
        const previous=prior && JSON.parse(prior.body);
        const scheduleChanged=!previous || JSON.stringify(previous.schedule)!==JSON.stringify(job.schedule);
        const next=previous?.enabled && job.enabled && !scheduleChanged?prior.due:nextOccurrence(job.schedule,now);
        job.updatedAtMs=now;
        this.db.prepare('INSERT INTO jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,due=excluded.due')
            .run(job.id,JSON.stringify(job),job.enabled?next:null);
    }
    remove(id){return this.db.prepare('DELETE FROM jobs WHERE id=?').run(id).changes;}
    recover(){return this.db.prepare("UPDATE occurrences SET status='uncertain',detail='Stopped while running' WHERE status='started'").run().changes;}
    claim(now=Date.now(),manualId){
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const row=manualId?this.db.prepare('SELECT id,body,due FROM jobs WHERE id=?').get(manualId):
                this.db.prepare('SELECT id,body,due FROM jobs WHERE due<=? AND NOT EXISTS(SELECT 1 FROM occurrences WHERE job=jobs.id AND status=\'started\') ORDER BY due,id LIMIT 1').get(now);
            if(!row){this.db.exec('COMMIT');return;}
            const job=JSON.parse(row.body),id=randomUUID(),slot=manualId?now:row.due;
            if(!job.enabled || this.db.prepare("SELECT 1 FROM occurrences WHERE job=? AND status='started'").get(job.id)){
                this.db.exec('COMMIT');return;
            }
            this.db.prepare('INSERT INTO occurrences(id,job,slot,status) VALUES (?,?,?,?)').run(id,job.id,slot,'started');
            if(!manualId || row.due<=now)this.db.prepare('UPDATE jobs SET due=? WHERE id=?').run(nextOccurrence(job.schedule,now),job.id);
            this.db.exec('COMMIT');return {id,job,slot};
        }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    finish(occurrence,status,detail='',summary,modelInfo){
        if(!['completed','failed','uncertain'].includes(status))throw Error('Invalid outcome');
        this.db.exec('BEGIN IMMEDIATE');
        try{
            const changed=this.db.prepare("UPDATE occurrences SET status=?, detail=?, summary=?, model_info=? WHERE id=? AND status='started'")
                .run(status,String(detail).slice(0,1000),summary??null,modelInfo?JSON.stringify(modelInfo):null,occurrence.id).changes;
            if(changed){
                const latest=this.get(occurrence.job.id);
                if(latest){
                    const ok=status==='completed',ended=Date.now();
                    latest.updatedAtMs=ended;
                    latest.state={...latest.state,lastRunAtMs:occurrence.slot,lastRunStatus:ok?'ok':'error',lastStatus:ok?'ok':'error',
                        consecutiveErrors:ok?0:(latest.state?.consecutiveErrors??0)+1,lastError:ok?undefined:String(detail).slice(0,1000)};
                    if(latest.delivery?.mode==='announce'){
                        latest.state.lastDelivered=ok?true:undefined;
                        latest.state.lastDeliveryStatus=ok?'delivered':'unknown';
                    }
                    if(latest.schedule.kind==='at')latest.enabled=false;
                    this.db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(latest),latest.id);
                    if(status==='completed'&&latest.deleteAfterRun)this.remove(latest.id);
                }
            }
            this.db.exec('COMMIT');
        }catch(e){this.db.exec('ROLLBACK');throw e;}
    }
    close(){this.db.close();}
}
