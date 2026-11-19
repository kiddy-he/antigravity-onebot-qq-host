const running = new Set(['starting','waiting_for_verification','checking']);
export function verificationAdmission(state, now=Date.now()) {
    if (!state) return 'start';
    if (running.has(state.status) && state.expiresAt>now) return 'pending';
    if (state.cooldownUntil>now) return 'cooldown';
    return 'start';
}
export const xhsVerificationPending = () => false;
export const requestXhsVerification = () => ({status:'unavailable'});
