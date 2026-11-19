/** Recognize provider error envelopes, never infer policy from ordinary conversation. */
const POLICY_TEXT = /^the prompt could not be submitted[.\s]*the prompt contains sensitive words that violate Google's[\s\S]{0,100}?Prohibited Use policy/iu;
const TECHNICAL_TEXT = /^(?:LLM request failed\.?|upstream (?:request|model|image generation) failed(?:\s*[:(][\s\S]*)?|(?:502|503|504)\s+(?:bad gateway|service unavailable|gateway time-?out))$/iu;
const TECHNICAL_KINDS = new Set(['timeout','network_error','rate_limited','upstream_5xx','empty_output','incomplete_output','invalid_schema','validation_failed','model_unavailable']);
export function modelReplyFailure({text, error} = {}) {
    const value = typeof text === 'string' ? text.trim() : '';
    const message = typeof error === 'string' ? error : String(error?.message ?? '');
    const kind = error?.kind;
    if (kind === 'policy_blocked' || POLICY_TEXT.test(value) || POLICY_TEXT.test(message.trim())
        || (error && /\b(?:PROHIBITED_CONTENT|SAFETY|BLOCKLIST|SPII|content_filter)\b/u.test(message)))
        return {kind:'policy_blocked', retryable:false};
    if (TECHNICAL_TEXT.test(value) || (error && TECHNICAL_TEXT.test(message.trim()))) return {kind:'upstream_5xx', retryable:true};
    if (!error) return null;
    if (kind) return {kind, retryable:TECHNICAL_KINDS.has(kind)};
    if (error?.name === 'AbortError') return {kind:'cancelled', retryable:false};
    const status = Number(error?.status ?? error?.statusCode ?? /(?:^|HTTP\s+|status[=: ]+)([45]\d{2})\b/iu.exec(message)?.[1]);
    if (status === 401 || status === 403) return {kind:'authentication_error', retryable:false};
    if (status === 429) return {kind:'rate_limited', retryable:true};
    if (status >= 500) return {kind:'upstream_5xx', retryable:true};
    if (status >= 400) return {kind:'invalid_request', retryable:false};
    if (/timeout|timed out|ETIMEDOUT/iu.test(message+' '+(error?.code??'')) || error?.name === 'TimeoutError') return {kind:'timeout', retryable:true};
    if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up/iu.test(message+' '+(error?.code??'')))
        return {kind:'network_error', retryable:true};
    return {kind:'unknown_error', retryable:false};
}
export const MODEL_POLICY_STATUS = '这次请求被上游的内容安全规则拒绝，未能完成。可以调整请求后再试。';
