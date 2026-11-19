import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { onebotPath } from './paths.js';
import { cleanConversationText } from './text-boundary.js';

export const CONTEXT_SUMMARY_START = '[[OPENCLAW_CONTEXT_SUMMARY]]';
export const CONTEXT_SUMMARY_END = '[[/OPENCLAW_CONTEXT_SUMMARY]]';

export function parseReplyAndConversationSummary(text) {
    const value = String(text ?? '').trim();
    const start = value.lastIndexOf(CONTEXT_SUMMARY_START);
    if (start < 0) return { reply: value, summary: '', receiptText: value };
    const body = start + CONTEXT_SUMMARY_START.length;
    const end = value.indexOf(CONTEXT_SUMMARY_END, body);
    const reply = value.slice(0, start).trim();
    // The QQ renderer also hides incomplete trailers. Only one complete, terminal
    // protocol block can be excluded when comparing a native turn to its receipt.
    const complete = end >= 0 && end + CONTEXT_SUMMARY_END.length === value.length
        && value.indexOf(CONTEXT_SUMMARY_START) === start && value.indexOf(CONTEXT_SUMMARY_END) === end;
    return { reply, summary: normalizeConversationSummary(value.slice(body, end < 0 ? value.length : end)),
        receiptText: complete ? reply : value };
}

export function normalizeConversationSummary(value) {
    return cleanConversationText(value).replace(/\s+/gu, ' ')
        .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/giu, '[敏感信息]')
        .replace(/https?:\/\/\S+/giu, '[链接]')
        .replace(/(?:\/root\/|\/etc\/|localhost|127\.0\.0\.1)\S*/giu, '[内部路径]')
        .trim().slice(0, 1500);
}

// All writes and resets share one queue. Epochs invalidate writers that started
// before reset, including delayed model, media and delivery completions.
export function createConversationSummaryStore({ sessionPath = onebotPath('state', 'onebot-conversation-summaries.json'),
    rolePath = onebotPath('state', 'onebot-role-summaries.json'), now = Date.now } = {}) {
    let queue = Promise.resolve();
    const epochs = new Map();
    const epoch = key => epochs.get(key) ?? 0;
    const capture = (sessionKey, agentId) => ({ sessionKey, agentId, sessionEpoch: epoch(`s:${sessionKey}`), roleEpoch: epoch(`r:${agentId}`) });
    const current = token => !!token && token.sessionEpoch === epoch(`s:${token.sessionKey}`) && token.roleEpoch === epoch(`r:${token.agentId}`);
    async function read(path) {
        try { const value = JSON.parse(await readFile(path, 'utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) return value; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        return {};
    }
    async function save(path, value) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        await rename(temporary, path);
    }
    const enqueue = task => { const pending = queue.catch(() => {}).then(task); queue = pending; return pending; };
    return {
        capture, current,
        async readSession(key) { await queue.catch(() => {}); const value = (await read(sessionPath))[key]; return normalizeConversationSummary(typeof value === 'string' ? value : value?.summary); },
        async readRole(key) { await queue.catch(() => {}); return normalizeConversationSummary((await read(rolePath))[key]?.summary); },
        writeSession(key, value, token) { return write(sessionPath, key, value, token); },
        writeRole(key, value, token) { return write(rolePath, key, value, token); },
        clear({ sessionKeys, agentId, clearRole = true }) {
            for (const key of sessionKeys) epochs.set(`s:${key}`, epoch(`s:${key}`) + 1);
            if (clearRole) epochs.set(`r:${agentId}`, epoch(`r:${agentId}`) + 1);
            return enqueue(async () => {
                const sessions = await read(sessionPath);
                // Include orphaned participant entries even if their native
                // sessions have already been deleted from the agent database.
                const belongs = key => sessionKeys.some(base => key === base ||
                    /:onebot:group:/u.test(base) && key.startsWith(`${base}:account:`));
                for (const key of Object.keys(sessions)) if (belongs(key)) delete sessions[key];
                await save(sessionPath, sessions);
                if (clearRole) { const roles = await read(rolePath); delete roles[agentId]; await save(rolePath, roles); }
            });
        },
    };
    function write(path, key, value, token) {
        const summary = normalizeConversationSummary(value);
        if (!key || !summary || !current(token)) return Promise.resolve(false);
        return enqueue(async () => {
            if (!current(token)) return false;
            const state = await read(path);
            if (!current(token)) return false;
            state[key] = { summary, updatedAtMs: now() };
            const entries = Object.entries(state).filter(([, entry]) => typeof entry?.summary === 'string')
                .sort((a,b) => Number(b[1].updatedAtMs ?? 0) - Number(a[1].updatedAtMs ?? 0)).slice(0, 256);
            await save(path, Object.fromEntries(entries));
            return true;
        });
    }
}
export const conversationSummaries = createConversationSummaryStore();
