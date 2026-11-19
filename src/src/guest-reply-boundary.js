import { onebotRoot } from './paths.js';

// This is an output disclosure guard, not an intent classifier or a ban on
// technical subjects. Markdown fences, circuit terminals, public software
// names and localhost examples do not establish access to private host data.
const CREDENTIAL = /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}|\bAIza[A-Za-z0-9_-]{20,}|\bAQ\.[A-Za-z0-9_-]{24,}|\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu;
const PRIVATE_PATH = /\/(?:root|home\/[^/\s]+)\/\.(?:openclaw|codex|ssh)(?=\/|\b)/u;
const INTERNAL_CONTEXT = /\[(?:Shared conversation transcript|Shared role capability contract|Group execution gate|Scoped business execution):?|\[\[OPENCLAW_CONTEXT_SUMMARY\]\]/u;
const WITHHELD = '这段回复中混入了不能公开的内部信息，暂时无法直接发送。请重新提问，我会只围绕你的问题回答。';

export function inspectGuestReply(text, { privateRoot = onebotRoot } = {}) {
    const value = String(text ?? '').trim();
    if (!value) return { text: '这次没有生成完整回复，请再试一次。', blocked: true, reason: 'empty_output' };
    let reason;
    if (CREDENTIAL.test(value)) reason = 'credential';
    else if (PRIVATE_PATH.test(value) || (privateRoot && value.includes(privateRoot + '/'))) reason = 'private_path';
    else if (INTERNAL_CONTEXT.test(value)) reason = 'internal_context';
    return reason ? { text: WITHHELD, blocked: true, reason } : { text: value, blocked: false };
}
