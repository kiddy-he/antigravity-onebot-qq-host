import { conversationSummaries } from './conversation-summaries.js';
import { parseApprovalSessionKey } from './approval-session.js';
import { loadWorkspaceRoutes } from './workspaces/routes.js';
import { destinationForSession } from './destination-context.js';
import { resetDestinationContext } from './destination-context.js';
import { cancelConversationTurns } from './conversation-transcript.js';

export function conversationResetCommand(text) {
    const command = /^\/(new|reset|fresh|clear)\s*$/iu.exec(String(text ?? '').trim())?.[1]?.toLowerCase();
    return command ? { command: `/${command}`, hard: ['fresh', 'clear'].includes(command) } : null;
}

const managed = new Set();
const pendingNative = new Map();

// The same reset path is used for managed private, guest and every group stream.
export async function resetConversationState({ sessionKeys, agentId, clearRole = true, target, hard, resetSession }, {
    summaries = conversationSummaries, resetDestination = resetDestinationContext, cancel = cancelConversationTurns,
} = {}) {
    if (!sessionKeys.length) throw new Error('missing reset session scope');
    for (const key of sessionKeys) cancel(key);
    // Persist an import cutoff before awaiting RPC, so no late history import
    // can make pre-reset platform messages visible again, including on restart.
    resetDestination(target, { strict: true });
    await summaries.clear({ sessionKeys, agentId, clearRole });
    for (const key of sessionKeys) {
        managed.add(key);
        try { await resetSession(key, hard); } finally { managed.delete(key); }
    }
}

// Core /new, /reset and operator session-reset RPCs can bypass channel command
// matching. Their async hook must finish before another prompt is built.
export function registerConversationResetHooks(api, { summaries = conversationSummaries,
    resetDestination = resetDestinationContext, cancel = cancelConversationTurns,
    routes = loadWorkspaceRoutes, destination = destinationForSession } = {}) {
    api.on('before_reset', (_event, ctx) => {
        const key = ctx.sessionKey;
        if (!key || managed.has(key) || !parseApprovalSessionKey(key)) return;
        const config = routes(), agentId = key.split(':')[1], agent = config.agents[agentId];
        if (!agent || agent.purpose !== 'main') return;
        const target = destination(key, { routes: config });
        if (!target) return;
        cancel(key);
        resetDestination(target, { strict: true });
        const pending = summaries.clear({ sessionKeys: [key], agentId, clearRole: agent.scope !== 'visitor' });
        pendingNative.set(key, pending);
        pending.catch(() => { api.logger?.error?.('[onebot] Native reset context cleanup failed; prompt remains blocked'); });
        return pending;
    });
    api.on('before_prompt_build', async (_event, ctx) => {
        const pending = pendingNative.get(ctx.sessionKey);
        if (pending) { await pending; if (pendingNative.get(ctx.sessionKey) === pending) pendingNative.delete(ctx.sessionKey); }
    });
}
