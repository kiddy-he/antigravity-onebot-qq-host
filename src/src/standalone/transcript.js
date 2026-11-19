import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {onebotPath} from '../paths.js';

let shared;
export function standaloneTranscript(){
    if(!shared) shared=new TranscriptStore(onebotPath('state','standalone','transcript.sqlite'));
    return shared;
}

export function hostVisibleEntries({storePath,sessionId,sessionKey}) {
    if(!storePath||!existsSync(storePath))return [];
    const db=new DatabaseSync(storePath,{readOnly:true});
    try{
        const active=db.prepare('SELECT current_session_id FROM session_nodes WHERE session_key=?').get(sessionKey);
        if(active?.current_session_id!==sessionId)return [];
        const rows=db.prepare('SELECT t.event_json FROM session_transcript_active_events a JOIN transcript_events t ON t.session_id=a.session_id AND t.seq=a.event_seq WHERE a.session_id=? AND a.message_position IS NOT NULL ORDER BY a.active_position DESC LIMIT 250').all(sessionId);
        return rows.reverse().map(row=>JSON.parse(row.event_json)).filter(e=>e.type==='message').map(e=>({message:e.message,createdAt:e.timestamp}));
    }finally{db.close();}
}

export class TranscriptStore {
    constructor(file){
        mkdirSync(dirname(file),{mode:0o700,recursive:true});this.db=new DatabaseSync(file);
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions(agent TEXT NOT NULL,scope TEXT NOT NULL,current TEXT NOT NULL,PRIMARY KEY(agent,scope)); CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY,session TEXT NOT NULL,receipt TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(session,receipt))');
        this.db.exec('CREATE TABLE IF NOT EXISTS host_origins(agent TEXT,scope TEXT,host_id TEXT,reset_count INTEGER NOT NULL,imported_through INTEGER NOT NULL,PRIMARY KEY(agent,scope))');
    }
    hostIdentity(agentId,scope){
        const file=onebotPath('agents',agentId,'agent','openclaw-agent.sqlite');
        if(!existsSync(file))return null;
        const db=new DatabaseSync(file,{readOnly:true});
        try{return db.prepare('SELECT current_session_id FROM session_nodes WHERE session_key=?').get(scope)?.current_session_id??null;}
        finally{db.close();}
    }
    currentGeneration(agentId,sessionKey){return this.db.prepare('SELECT current FROM sessions WHERE agent=? AND scope=?').get(agentId,sessionKey)?.current;}
    target({agentId,sessionKey}){
        if(!/^[a-z0-9_-]+$/u.test(agentId)||!sessionKey)throw Error('Invalid session identity');
        this.db.exec('BEGIN IMMEDIATE');
        try{
            let sessionId=this.currentGeneration(agentId,sessionKey);
            if(!sessionId){
                const oldId=this.hostIdentity(agentId,sessionKey);
                sessionId=randomUUID();
                this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(agentId,sessionKey,sessionId);
                const storePath=onebotPath('agents',agentId,'agent','openclaw-agent.sqlite');
                if(oldId){
                    for(const {message} of hostVisibleEntries({storePath,sessionId:oldId,sessionKey})){
                        if(!['input','delivered'].includes(message.onebotConversation?.kind))continue;
                        this.db.prepare('INSERT OR IGNORE INTO messages(session,receipt,body) VALUES (?,?,?)').run(sessionId,
                            message.idempotencyKey??randomUUID(),JSON.stringify(message));
                    }
                }
                const through=this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE session=?').get(sessionId).seq;
                this.db.prepare('INSERT INTO host_origins VALUES (?,?,?,0,?)').run(agentId,sessionKey,oldId,through);
            }
            this.db.exec('COMMIT');return {agentId,sessionKey,sessionId,standalone:true};
        }catch(e){this.db.exec('ROLLBACK');throw e;}
    }
    entries({agentId,sessionKey,sessionId,standalone,storePath}){
        if(!standalone && storePath)return hostVisibleEntries({storePath,sessionId,sessionKey});
        return this.db.prepare('SELECT m.body FROM messages m JOIN sessions s ON m.session=s.current WHERE s.agent=? AND s.scope=? AND s.current=? ORDER BY m.seq DESC LIMIT 250').all(agentId,sessionKey,sessionId)
            .reverse().map(r=>({message:JSON.parse(r.body)}));
    }
    append({agentId,sessionKey,sessionId,message}){
        const live=this.db.prepare('SELECT current FROM sessions WHERE agent=? AND scope=?').get(agentId,sessionKey);
        if(live?.current!==sessionId)return {kind:'obsolete'};
        const result=this.db.prepare('INSERT OR IGNORE INTO messages(session,receipt,body) SELECT current,?,? FROM sessions WHERE agent=? AND scope=? AND current=?').run(
            message.idempotencyKey??randomUUID(),JSON.stringify(message),agentId,sessionKey,sessionId);
        if(!result.changes && this.db.prepare('SELECT current FROM sessions WHERE agent=? AND scope=?').get(agentId,sessionKey)?.current!==sessionId)
            return {kind:'obsolete'};
        return {kind:'result',result:{appended:!!result.changes,messageId:String(result.lastInsertRowid)}};
    }
    reset(agentId,scope,hard){
        this.db.exec('BEGIN IMMEDIATE');
        try{
            const row=this.db.prepare('SELECT current FROM sessions WHERE agent=? AND scope=?').get(agentId,scope);
            this.db.prepare('INSERT INTO host_origins VALUES (?,?,?,1,0) ON CONFLICT(agent,scope) DO UPDATE SET reset_count=reset_count+1,imported_through=0')
                .run(agentId,scope,this.hostIdentity(agentId,scope));
            if(row && hard)this.db.prepare('DELETE FROM messages WHERE session=?').run(row.current);
            this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(agentId,scope,randomUUID());
            this.db.exec('COMMIT');
        }catch(e){this.db.exec('ROLLBACK');throw e;}
    }
    close(){this.db.close();}
}
