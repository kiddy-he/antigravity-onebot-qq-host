import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {onebotPath} from '../paths.js';
import {AiError} from './router.js';
import {metric} from './metrics.js';

// Shared by the gateway, cron workers and skill subprocesses. Review capacity
// is independent: a chat waiting on a tool can itself need a reviewer.
const limits={chat:2,task:2,review:1};
export async function withCliCapacity(lane,signal,timeoutMs,work,{file=onebotPath('state','antigravity','capacity.sqlite')}={}){
    const queuedAt=Date.now(),end=queuedAt+timeoutMs;
    const timeout=AbortSignal.timeout(Math.max(1,timeoutMs));
    const stop=signal?AbortSignal.any([signal,timeout]):timeout;
    mkdirSync(dirname(file),{mode:0o700,recursive:true});
    const db=new DatabaseSync(file),id=randomUUID();
    let acquired=false;
    try {
        db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY,lane TEXT NOT NULL,expires INTEGER NOT NULL)');
        for(;;){
            stop.throwIfAborted();db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare('DELETE FROM slots WHERE expires<=?').run(Date.now());
                const count=db.prepare('SELECT COUNT(*) AS n FROM slots WHERE lane=?').get(lane).n;
                if(count<limits[lane]){
                    db.prepare('INSERT INTO slots VALUES (?,?,?)').run(id,lane,end+2000);db.exec('COMMIT');break;
                }
                db.exec('COMMIT');
            }catch(e){db.exec('ROLLBACK');throw e;}
            await delay(Math.min(120,Math.max(1,end-Date.now())),undefined,{signal:stop});
        }
        acquired=true;
        metric('capacity',{lane,acquired,waitMs:Date.now()-queuedAt});
        return await work(stop,Math.max(1,end-Date.now()));
    }catch(error){
        if(!acquired)metric('capacity',{lane,acquired,waitMs:Date.now()-queuedAt});
        if(stop.aborted)throw new AiError(signal?.aborted && signal.reason?.name!=='TimeoutError'?'cancelled':'timeout');
        throw error;
    }finally {
        try {db.prepare('DELETE FROM slots WHERE id=?').run(id);} finally {db.close();}
    }
}
