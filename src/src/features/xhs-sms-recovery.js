export function challengeErrors(result) {
    return [result?.error,result?.data?.error,...(result?.data?.resources ?? []).map(r=>r.error)].filter(Boolean);
}
export function isChallenge(result) { return challengeErrors(result).some(e=>e.code==='challenge_required'); }
export function isLoginRequired(result) { return challengeErrors(result).some(e=>e.code==='login_required'); }
export function isRecoverableAuth(result) { return isChallenge(result) || isLoginRequired(result); }
