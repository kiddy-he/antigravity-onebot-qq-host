/** Only inspect this inbound event's own text; never quotes, forwards or history. */
export function parseMarketCommand(text) {
    if (typeof text !== 'string') return null;
    const value = text.trim();
    if (!/^\/fx(?=\s|$)/u.test(value)) return null;
    const body = value.slice(3).trim();
    return { body, help: body === '' || ['帮助', 'help', '?', '？'].includes(body) };
}
export function marketCommandForMessages(messages, {internal = false} = {}) {
    if (internal || !Array.isArray(messages) || messages.length !== 1) return null;
    const message = messages[0];
    const segments = message.event?.message;
    const text = Array.isArray(segments)
        ? segments.filter(s => s.type === 'text').map(s => String(s.data?.text ?? '')).join('')
        : message.text;
    return parseMarketCommand(text);
}
export function requireMarketCommand(context) {
    if (context?.sharemarketCommand !== true || context.internal || context.actorType === 'service')
        throw new Error('股市操作需要在本轮消息开头使用 /fx。');
}
