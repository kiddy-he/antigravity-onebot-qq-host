import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {onebotPath} from '../paths.js';
import {parseReplyAndConversationSummary} from '../conversation-summaries.js';
import {AiError} from './router.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const path=()=>onebotPath('state','antigravity','sessions.sqlite');
let shared;
export function subscriptionSessions({existing=false}={}) {
    if(!shared && (!existing || existsSync(path()))) shared=new CliSessionStore(path());
    return shared;
}

export class CliSessionStore {
    constructor(file){
        mkdirSync(dirname(file),{recursive:true,mode:0o700});
        this.db=new DatabaseSync(file);
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
        this.db.exec('CREATE TABLE IF NOT EXISTS cli_sessions (scope TEXT PRIMARY KEY, revision TEXT NOT NULL, native_id TEXT, claim TEXT, deadline INTEGER, request TEXT, candidate TEXT, confirmed INTEGER NOT NULL DEFAULT 0)');
    }
    acquire(scope,revision,request,timeoutMs){
        const token=randomUUID(), now=Date.now();
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const row=this.db.prepare('SELECT * FROM cli_sessions WHERE scope=?').get(scope);
            if(row?.claim && row.deadline>now) throw new AiError('rate_limited','QQ conversation already has an active turn');
            const nativeId=row && !row.claim && row.confirmed && row.revision===revision ? row.native_id:undefined;
            this.db.prepare('INSERT OR REPLACE INTO cli_sessions (scope,revision,native_id,claim,deadline,request) VALUES (?,?,?,?,?,?)')
                .run(scope,revision,nativeId??null,token,now+timeoutMs+3000,request);
            this.db.exec('COMMIT');
            return {token,nativeId};
        } catch(error) { this.db.exec('ROLLBACK');throw error; }
    }
    finish(scope,token,nativeId,candidate,{receiptRequired=true}={}){
        const row=this.db.prepare('UPDATE cli_sessions SET claim=NULL,deadline=NULL,native_id=?,candidate=?,confirmed=? WHERE scope=? AND claim=?')
            .run(nativeId,digest(parseReplyAndConversationSummary(candidate).receiptText),receiptRequired?0:1,scope,token);
        if(!row.changes) throw new AiError('cancelled','Native turn superseded by a reset');
    }
    fail(scope,token){
        this.db.prepare('DELETE FROM cli_sessions WHERE scope=? AND claim=?').run(scope,token);
    }
    delivered(scope,request,text){
        // A fallback or rewrite that bypassed the CLI changes public history.
        // Rebuild on the next turn, even if the process crashed after sending.
        this.db.prepare('UPDATE cli_sessions SET confirmed=CASE WHEN request=? AND candidate=? AND claim IS NULL THEN 1 ELSE 0 END WHERE scope=?')
            .run(String(request),digest(String(text).trim()),scope);
    }
    reset(scope){this.db.prepare('DELETE FROM cli_sessions WHERE scope=?').run(scope);}
    close(){this.db.close();}
}
