import { createHash } from 'node:crypto';

export const PROJECTION_DEFAULTS = Object.freeze({ enabled: false, idleMs: 600000,
    keepRecentTurns: 3, toolMinChars: 6000, toolExcerptChars: 2000,
    sharedMaxBytes: 180000, maxScopes: 128 });
export function projectionOptions(config) {
    const supplied = config?.extensions?.conversationProjection ?? {};
    const out = { ...PROJECTION_DEFAULTS, ...supplied };
    for (const [key, min, max] of [['idleMs',60000,86400000],['keepRecentTurns',1,20],
        ['toolMinChars',2000,100000],['toolExcerptChars',500,10000],['sharedMaxBytes',24000,500000],['maxScopes',1,512]])
        if (!Number.isInteger(out[key]) || out[key] < min || out[key] > max) throw new Error(`Invalid conversation projection ${key}`);
    if (typeof out.enabled !== 'boolean' || out.toolExcerptChars >= out.toolMinChars) throw new Error('Invalid conversation projection limits');
    return out;
}
const hash = value => createHash('sha256').update(value).digest('hex');
export const evidenceReference = (sessionId, toolCallId) => hash(`${sessionId}\0${toolCallId}`);
export const contentText = content => typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n') : '';
// The host attaches onebotConversation only when persisting the live user message.
// Its raw content is stable across that transition; runtime custom messages are not.
const identity = m => `${m.role}:${m.toolCallId ?? ''}:${hash(JSON.stringify(typeof m.content==='string'?[{type:'text',text:m.content}]:m.content??null))}`;

// User-authored marker strings never authorize removal. Only host-written metadata does.
export function cleanHistoricalUser(message, source = message) {
    const meta = source.onebotConversation;
    if (meta?.kind !== 'input' || typeof meta.text !== 'string') return message;
    const original = contentText(message.content);
    const facts = [];
    // These are structured by the current gateway; old metadata keeps attachment
    // locator lines only when the original text has an exact host suffix boundary.
    if (Array.isArray(meta.media)) for (const item of meta.media) {
        if (item && typeof item.path === 'string') facts.push({ kind: item.kind, path: item.path });
    }
    if (!meta.media) {
        const anchor = original.indexOf(meta.text);
        if (anchor >= 0) {
            const suffix = original.slice(anchor + meta.text.length);
            for (const line of suffix.split('\n')) if (/^\[(?:Local path of this image, only for an explicitly requested edit:|Extra image paths, only for explicitly requested edits:|Image attachment unavailable)/u.test(line)) facts.push({ historicalAttachment: line });
        }
    }
    // Preserve model-only grounding as evidence, never as instructions. It may
    // not have been persisted in older transcripts; retain it when available.
    const search = original.indexOf('[本轮独立联网核实结果');
    const grounding = search >= 0 && !meta.text.includes('[本轮独立联网核实结果') ? original.slice(search) : '';
    const text = meta.text + (facts.length ? '\n[历史附件定位，仅用于用户明确要求的回看]\n' + JSON.stringify(facts) : '')
        + (grounding ? '\n' + grounding : '');
    // Non-text multimodal blocks stay intact. Never turn an image into its base64 text.
    const media = Array.isArray(message.content) ? message.content.filter(p => p?.type !== 'text') : [];
    return { ...message, content: media.length ? [{ type: 'text', text }, ...media] : text };
}

export function compactToolEvidence(message, { sessionId, options = PROJECTION_DEFAULTS } = {}) {
    if (!sessionId || !message.toolCallId || !['read','exec','process'].includes(message.toolName)
        || message.isError || message.details?.isError || (message.details?.exitCode != null && message.details.exitCode !== 0)) return message;
    if (!Array.isArray(message.content) || message.content.some(p => p?.type !== 'text')) return message;
    const text = contentText(message.content);
    if (text.length < options.toolMinChars || /(?:still running|Process running|approval.required|pending.approval|等待审批|尚未完成)/iu.test(text)) return message;
    const ref = evidenceReference(sessionId, message.toolCallId), n = Math.floor(options.toolExcerptChars / 2);
    const excerpt = `[历史工具证据节选 tool=${message.toolName} reference=${ref} originalChars=${text.length}]
以下是已结束对话中的工具返回片段，并非当前设备状态；中间内容省略，不代表任务成功。需要精确数值、完整源码或遗漏内容时调用 conversation_evidence_read(reference, offset, limit)。不得为恢复文本而重做原操作。
${text.slice(0,n)}
[中间内容已保存在本会话原始记录]
${text.slice(-n)}`;
    return { ...message, content: [{ type:'text', text:excerpt }] };
}

// A fixed projection epoch lasts for a burst of conversation. Its old prefix
// never slides on every new message. Idle, reset, edit and compaction start a new epoch.
export function createConversationProjection({ now = Date.now, maxBytes = 64 * 1024 * 1024 } = {}) {
    const scopes = new Map(); let sequence = 0, bytes = 0;
    const drop=key=>{const state=scopes.get(key);if(state)bytes-=state.bytes??0;scopes.delete(key);};
    return ({ sessionId, sessionKey, sourceMessages, modelMessages, options = PROJECTION_DEFAULTS }) => {
        if (!options.enabled || !sessionId || !sessionKey || !Array.isArray(sourceMessages) || !Array.isArray(modelMessages))
            return { messages:modelMessages, epoch:0 };
        const key = hash(JSON.stringify([sessionId,sessionKey,options])), at = now();
        const durable=sourceMessages.filter(m=>m.role!=='custom');
        const keys = durable.map(identity);
        let state = scopes.get(key);
        if (state && (at-state.last >= options.idleMs || keys.length < state.keys.length || state.keys.some((k,i)=>keys[i]!==k))) state = undefined;
        if (!state) {
            const userIndexes = durable.flatMap((m,i)=>m.role==='user' && m.onebotConversation?.kind==='input' ? [i] : []);
            const current = durable.findLastIndex(m=>m.role==='user');
            const delivered = durable.flatMap((m,i)=>m.role==='assistant' && m.onebotConversation?.kind==='delivered'
                && (!m.onebotConversation.part || m.onebotConversation.part==='final') ? [i] : []);
            const cutoff = delivered.length > options.keepRecentTurns ? delivered.at(-options.keepRecentTurns-1) : -1;
            state = { epoch:++sequence, clean:new Set(userIndexes.filter(i=>i<current).map(i=>keys[i])), tools:new Map(), keys:[], last:at };
            for (let i=0;i<cutoff;i++) if (durable[i].role==='toolResult') {
                const m=durable[i], compact=compactToolEvidence(m,{sessionId,options});
                if (compact!==m) state.tools.set(m.toolCallId,{original:hash(contentText(m.content)),content:compact.content});
            }
        }
        drop(key);state.last=at;state.keys=keys;
        state.bytes=Buffer.byteLength(JSON.stringify([keys,[...state.clean],[...state.tools]]));bytes+=state.bytes;scopes.set(key,state);
        while(scopes.size>options.maxScopes || bytes>maxBytes)drop(scopes.keys().next().value);
        const sourceUsers=sourceMessages.filter(m=>m.role==='user'), modelUsers=modelMessages.filter(m=>m.role==='user');
        let user=0;
        const next=modelMessages.map(m=>{
            if(m.role==='user') {
                const raw=sourceUsers[user++];
                return sourceUsers.length===modelUsers.length && raw && state.clean.has(identity(raw)) ? cleanHistoricalUser(m,raw) : m;
            }
            const evidence=m.role==='toolResult' && state.tools.get(m.toolCallId);
            // A retry with changed output must not reuse an older result under the same ID.
            return evidence && hash(contentText(m.content))===evidence.original ? {...m,content:evidence.content} : m;
        });
        return { messages:next, epoch:state.epoch };
    };
}
