// The private installation's SMS forwarding and operator callback are external to this distribution.
export const smsRecoveryEnabled = () => false;
export const xhsSmsPending = () => false;
export async function observeXhsChallenge() {}
export function rememberXhsRecoveryTurn() {}
export function finishXhsRecoveryTurn() {}
export async function handleXhsAuthReply() { return false; }
export function registerXhsRecovery() { return () => {}; }
export function cancelXhsRecoverySession() {}
