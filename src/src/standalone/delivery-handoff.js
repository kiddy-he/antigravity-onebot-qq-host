import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

// The legacy SDK drains only the outbound namespace. Retain the entire native
// record under its original ID so a restart can distinguish an adopted intent.
const archive = 'onebot-standalone-adopted';

function started(row, entry) {
    return row.platform_send_started_at != null || entry.platformSendStartedAt != null ||
        entry.platformSendAttemptId != null || [row.recovery_state,entry.recoveryState].some(
            state => state === 'send_attempt_started' || state === 'unknown_after_send');
}

function pristine(row, entry) {
    return row.retry_count === 0 && entry.retryCount === 0 && entry.attemptCount === 0 &&
        row.last_attempt_at == null && entry.lastAttemptAt == null && !started(row,entry) &&
        [row.recovery_state,entry.recoveryState].every(state => state == null || state === 'producer_claimed');
}

function matchesProducer(row, entry, local) {
    const request = JSON.parse(local.request);
    const target = request.target?.type + ':' + request.target?.id;
    return row.id === local.id && entry.id === local.id && (!local.native_id || local.native_id === row.id) &&
        entry.channel === 'onebot' && row.channel === 'onebot' && entry.accountId === request.accountId &&
        row.account_id === request.accountId && row.target === target && entry.to === target &&
        entry.requiresProducerClaim === true && entry.queuePolicy === 'required' && entry.completionRetention === 'permanent' &&
        request.parts?.length > 0 && entry.payloads?.length === request.parts.length &&
        entry.payloads.every((payload,index) => {
            const tag = payload.channelData?.onebotDelivery;
            return tag?.id === local.id && tag.index === index && tag.kind === request.parts[index].type;
        });
}

export function reconcileHostDeliveries(file, queue) {
    const host = new DatabaseSync(file);
    const db = queue.store.db;
    const stats = {pending:0, started:0, linkedStarted:0, adopted:0, held:0, restoredReceipts:0};
    try {
        host.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        if (!host.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_queue_entries'").get()) {
            host.exec('COMMIT'); return stats;
        }
        const pending = host.prepare("SELECT * FROM delivery_queue_entries WHERE queue_name='outbound' AND status='pending'").all();
        const attempts = new Set(), adopt = [];
        const byNative = db.prepare('SELECT id FROM deliveries WHERE native_id=? OR id=?');
        for (const row of pending) {
            const entry = JSON.parse(row.entry_json);
            if (row.channel !== 'onebot' && entry.channel !== 'onebot') continue;
            stats.pending++;
            if (started(row,entry)) {
                stats.started++;
                const links = new Set(byNative.all(row.id,row.id).map(link => link.id));
                for (const payload of entry.payloads ?? []) {
                    const id = payload.channelData?.onebotDelivery?.id;
                    if (typeof id === 'string' && queue.get(id)) links.add(id);
                }
                if (links.size) stats.linkedStarted++;
                for (const id of links) attempts.add(id);
                continue;
            }
            const local = queue.get(row.id);
            if (!pristine(row,entry) || !local || !matchesProducer(row,entry,local))
                throw Error('Pending legacy OneBot delivery requires its original gateway to drain or reconcile before handoff');
            adopt.push(row.id);
        }
        if (adopt.some(id => attempts.has(id))) throw Error('Conflicting legacy platform attempts require reconciliation');
        const toAdopt = new Set(adopt);
        const known = host.prepare("SELECT queue_name,status FROM delivery_queue_entries WHERE queue_name IN ('outbound',?) AND id=?");
        const partCount = db.prepare('SELECT COUNT(*) AS n FROM delivery_parts WHERE delivery_id=?');
        const setState = db.prepare('UPDATE deliveries SET state=?,updated=? WHERE id=?');
        // Commit eligibility first. If the process dies before the native rename,
        // both hosts can still recover the original stable ID through their own queue.
        queue.store.transaction(() => {
            for (const row of db.prepare("SELECT * FROM deliveries WHERE state IN ('ready','waiting_approval','dispatching','native_pending','uncertain')").all()) {
                const count = partCount.get(row.id).n;
                if (count) {
                    const receipt = queue.partReceipt(row.id,JSON.parse(row.request).parts);
                    if (receipt) { queue.set(row.id,'accepted',receipt); stats.restoredReceipts++; continue; }
                }
                const records = known.all(archive,row.id);
                if (row.native_id && row.native_id !== row.id) records.push(...known.all(archive,row.native_id));
                const owned = toAdopt.has(row.id);
                const archived = records.some(item => item.queue_name === archive);
                const ambiguous = attempts.has(row.id) || count > 0 ||
                    records.some(item => item.queue_name === 'outbound' && !(owned && item.status === 'pending'));
                if (owned && !ambiguous) {
                    if (!['ready','waiting_approval'].includes(row.state)) setState.run('ready',Date.now(),row.id);
                } else if (ambiguous || (!archived && row.native_id)) {
                    if (['ready','waiting_approval','dispatching'].includes(row.state)) setState.run('uncertain',Date.now(),row.id);
                    stats.held++;
                }
            }
        });
        const previousArchive = host.prepare("UPDATE delivery_queue_entries SET queue_name=? WHERE queue_name=? AND id=?");
        const move = host.prepare("UPDATE delivery_queue_entries SET queue_name=? WHERE queue_name='outbound' AND id=? AND status='pending'");
        for (const id of adopt) {
            // Returning from a previous cutover can admit the same producer ID
            // to the legacy outbound queue again. Preserve the earlier admission.
            previousArchive.run(archive+'-'+randomUUID(),archive,id);
            if (move.run(archive,id).changes !== 1) throw Error('Native delivery ownership changed during handoff');
            stats.adopted++;
        }
        host.exec('COMMIT');
        return stats;
    } finally { host.close(); }
}
