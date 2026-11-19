// Approval routing accepts both legacy conversations and isolated group streams.
// The suffix is trusted routing metadata, never a grant of approval permission.
export function parseApprovalSessionKey(sessionKey) {
    const match = /^agent:([^:]+):onebot:(?:(grok):)?(direct:private|group)(?::group)?:(\d+)(?::role:([^:]+):mode:(normal|nsfw))?(?::account:([A-Za-z0-9_-]{1,64}):sender:([1-9][0-9]{4,19}))?$/u.exec(String(sessionKey ?? ''));
    if (!match || (match[7] && (match[3] !== 'group' || !match[5]))) return null;
    return { agentId: match[1], scope: match[3] === 'group' ? 'group' : 'private', peerId: match[4],
        accountId: match[7], senderId: match[8] };
}
