// Site-specific maintenance commands require a separately maintained operator integration.
export function inspectionPlan() { throw Error('No site inspection commands configured'); }
export function inspectionCommand() { throw Error('No site inspection commands configured'); }
export async function inspectLocal() { throw Error('No site inspection commands configured'); }
