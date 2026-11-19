import { canonicalAgentId, loadWorkspaceRoutes } from '../workspaces/routes.js';

// Inputs are trusted routing/session metadata, never message text or tool args.
export function conversationProfile({ mode, sessionKey, workspaceAgentId } = {}, routes) {
    if (mode === 'nsfw' || mode === 'grok') return 'isolated';
    const key = String(sessionKey ?? '');
    if (/^agent:onebot-grok:|:mode:nsfw(?::|$)/u.test(key)) return 'isolated';
    if (workspaceAgentId) {
        const metadata = (routes ?? loadWorkspaceRoutes()).agents[workspaceAgentId];
        if (metadata?.mode === 'nsfw') return 'isolated';
    }
    return undefined;
}

export function groupConversationModeKey(groupId, roleAgentId, routes) {
    return `group:${String(groupId)}:role:${canonicalAgentId(roleAgentId, routes)}`;
}

// A shared arbitration input may contain messages from every participating role.
export function sharedConversationProfile(modes) {
    return modes.some(mode => conversationProfile({ mode }) === 'isolated') ? 'isolated' : undefined;
}
