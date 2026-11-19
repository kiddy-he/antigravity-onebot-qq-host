import { createHash } from 'node:crypto';
import {loadAiConfig} from './ai/config.js';
import { createConversationProjection, projectionOptions } from './conversation-projection.js';
import { preserveConversationFacts } from './conversation-facts.js';

// Process-local input projections only. Access-driven eviction performs no API calls.
export function createShortTermModelContext({ maxScopes = 128, maxMessages = 256, maxBytes = 64 * 1024 * 1024 } = {}) {
    const scopes = new Map();
    let bytes = 0;
    const fingerprint = content => {
        if (typeof content === 'string') content = [{ type: 'text', text: content }];
        return createHash('sha256').update(JSON.stringify(content ?? null)).digest('hex');
    };
    const drop = scope => { const value = scopes.get(scope); if (value) bytes -= value.bytes; scopes.delete(scope); };
    const eligible = m => m.role === 'user' && Number.isFinite(m.timestamp);
    return function restore({ scope, sourceMessages, modelMessages }) {
        if (typeof scope !== 'string' || !scope || !Array.isArray(sourceMessages) || !Array.isArray(modelMessages)) return modelMessages;
        scope = createHash('sha256').update(scope).digest('hex');
        const source = sourceMessages.filter(eligible).map(m => fingerprint(m.content));
        if (source.length !== modelMessages.filter(eligible).length) { drop(scope); return modelMessages; }
        let state = scopes.get(scope);
        // A queued current message uses processing time; its persisted replay uses
        // inbound event time. Match clean content in its append-only user sequence,
        // rather than the two different clocks. An edit, trim, reset or compaction
        // invalidates the whole scope before any old projection can be restored.
        if (state && (source.length < state.source.length || state.source.some((value, i) => source[i] !== value))) { drop(scope); state = undefined; }
        if (!state) state = { messages: new Map(), bytes: 0, source: [] };
        else scopes.delete(scope);
        state.source = source;
        scopes.set(scope, state);
        let changed = false, index = 0;
        const next = modelMessages.map(message => {
            if (!eligible(message)) return message;
            const id = `${index}:${source[index++]}`;
            const previous = state.messages.get(id);
            if (previous) {
                if (fingerprint(previous.content) === fingerprint(message.content)) return message;
                changed = true;
                return { ...message, content: structuredClone(previous.content) };
            }
            const content = structuredClone(message.content), size = Buffer.byteLength(JSON.stringify(content) ?? '');
            if (size <= maxBytes / 4) { state.messages.set(id, { content, size }); state.bytes += size; bytes += size; }
            return message;
        });
        while (state.messages.size > maxMessages) { const id = state.messages.keys().next().value, m = state.messages.get(id); state.messages.delete(id); state.bytes -= m.size; bytes -= m.size; }
        while (scopes.size > maxScopes || bytes > maxBytes) drop(scopes.keys().next().value);
        return changed ? next : modelMessages;
    };
}
const restoreDefault = createShortTermModelContext();
const projectDefault = createConversationProjection();
export function restoreShortTermModelContext(params) {
    const config=loadAiConfig();
    const options=projectionOptions(config);
    if(options.enabled)params=preserveConversationFacts(params);
    const projection=projectDefault({...params,options});
    const projected={...params,scope:`${params.scope}:projection:${projection.epoch}`,modelMessages:projection.messages};
    return config.extensions?.shortTermCache?.enabled === true ? restoreDefault(projected) : projection.messages;
}
