import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { onebotPath } from '../paths.js';

// Only the native cron runner opens this scope. Message text/channelData cannot
// grant final-text privileges. The ledger stores identities and receipts, never prompts.
// Plugin loaders and the native ESM runner may evaluate this module separately.
// Share the context in this process so neither loader can lose the cron scope.
const sharedKey = Symbol.for('openclaw.onebot.cron-lifecycle.v1:' + onebotPath('state/business/cron-delivery.sqlite'));
const shared = globalThis[sharedKey] ??= { scope: new AsyncLocalStorage() };
const scope = shared.scope;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class CronDeliveryLedger {
    constructor(path) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path); chmodSync(path, 0o600);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS occurrences(id TEXT PRIMARY KEY, job TEXT NOT NULL, route TEXT NOT NULL,
            slot INTEGER NOT NULL, retry_at INTEGER, completed INTEGER NOT NULL DEFAULT 0,
            uncertain INTEGER NOT NULL DEFAULT 0, receipts TEXT NOT NULL DEFAULT '[]', updated INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS occurrence_retry ON occurrences(job,route,retry_at);`);
    }
    begin(job, now) {
        const route = hash([job.delivery.channel, job.delivery.accountId ?? 'default', job.delivery.to, job.delivery.threadId ?? '']);
        const scheduled = Number(job.state?.nextRunAtMs);
        const retry = Number.isFinite(scheduled) && job.state?.consecutiveErrors > 0
            ? this.db.prepare('SELECT * FROM occurrences WHERE job=? AND route=? AND retry_at=? ORDER BY updated DESC LIMIT 1').get(job.id, route, scheduled) : null;
        const slot = retry?.slot ?? (Number.isFinite(scheduled) && scheduled <= now ? scheduled : now);
        const id = retry?.id ?? `onebot-cron-${hash([job.id, route, slot])}`;
        this.db.prepare('INSERT OR IGNORE INTO occurrences(id,job,route,slot,updated) VALUES(?,?,?,?,?)').run(id, job.id, route, slot, now);
        // Retain completed evidence well beyond daily/weekly retries, bound file growth.
        this.db.prepare('DELETE FROM occurrences WHERE updated<? AND completed=1').run(now - 30 * 86400000);
        return this.get(id);
    }
    get(id) { return this.db.prepare('SELECT * FROM occurrences WHERE id=?').get(id); }
    retry(id, at) { if (id) this.db.prepare('UPDATE occurrences SET retry_at=?,updated=? WHERE id=?').run(at, Date.now(), id); }
    dispatched(id) { this.db.prepare('UPDATE occurrences SET uncertain=1,updated=? WHERE id=?').run(Date.now(), id); }
    receipt(id, messageId) {
        const row = this.get(id), ids = JSON.parse(row.receipts);
        if (!ids.includes(String(messageId))) ids.push(String(messageId));
        this.db.prepare('UPDATE occurrences SET receipts=?,updated=? WHERE id=?').run(JSON.stringify(ids), Date.now(), id);
    }
    complete(id) { this.db.prepare('UPDATE occurrences SET completed=1,uncertain=0,updated=? WHERE id=?').run(Date.now(), id); }
    close() { this.db.close(); }
}
const ledger = () => shared.ledger ??= new CronDeliveryLedger(process.env.ONEBOT_CRON_DELIVERY_DB || onebotPath('state/business/cron-delivery.sqlite'));
const eligible = job => job?.payload?.kind === 'agentTurn' && job?.delivery?.channel === 'onebot' && job?.delivery?.mode === 'announce';
const received = outcome => ({ ...outcome, status: 'ok', error: undefined, errorClassification: undefined,
    diagnostics: undefined, deliveryError: undefined, deliveryAttempted: true, delivered: true, deliveryStatus: 'delivered' });

export async function withOneBotCronRun(job, run, { store, now = Date.now(), receiptWaitMs = 20000 } = {}) {
    if (!eligible(job)) return run();
    store ??= ledger();
    const occurrence = store.begin(job, now);
    const context = { id: occurrence.id, jobId: job.id, to: job.delivery.to.replace(/^onebot:/u, ''),
        accountId: job.delivery.accountId ?? 'default', store, pending: new Set(), accepted: 0, expected: 0 };
    const finish = async outcome => {
        // An already dispatched platform request has a separate 15s receipt deadline.
        // Never abort that HTTP exchange and throw away a successful QQ receipt.
        if (context.pending.size) {
            let timer;
            try { await Promise.race([Promise.allSettled([...context.pending]), new Promise(resolve => { timer = setTimeout(resolve, receiptWaitMs); })]); }
            finally { clearTimeout(timer); }
        }
        const row = store.get(context.id);
        const extra = { onebotCronOccurrenceId: context.id };
        if (row.completed) return { ...received(outcome), ...extra };
        if (row.uncertain) return { ...outcome, ...extra, status: 'error', onebotDeliveryUncertain: true,
            delivered: undefined, deliveryStatus: 'unknown', deliveryAttempted: true,
            error: 'cron: QQ 投递已发起，部分消息可能已送达，但完整送达状态尚未确认；为避免重复发送，本次不会自动重发。' };
        return { ...outcome, ...extra };
    };
    if (occurrence.completed) return { ...received({}), onebotCronOccurrenceId: context.id };
    // A restarted process cannot safely retry a platform request without a receipt.
    if (occurrence.uncertain) return finish({});
    return scope.run(context, async () => {
        try { return await finish(await run()); }
        catch (error) {
            const result = await finish({ status: 'error', error: String(error.message ?? error) });
            if (result.delivered || result.onebotDeliveryUncertain) return result;
            throw error;
        }
    });
}
export function rememberOneBotCronRetry(result, at) {
    if (result.onebotCronOccurrenceId) ledger().retry(result.onebotCronOccurrenceId, at);
}
export function oneBotCronIntent(jobId, fallback) {
    const current = scope.getStore();
    return current?.jobId === jobId ? current.id : fallback;
}
export function withOneBotCronDelivery(params, run) {
    const current = scope.getStore();
    if (!current || params.job.id !== current.jobId) return run();
    return scope.run({ ...current, finalDelivery: true, signal: params.abortSignal,
        // Shared counters and pending work must stay on the original run context.
        runContext: current }, run);
}
export function prepareOneBotCronBatch(count) {
    const current = scope.getStore();
    if (current?.finalDelivery) current.runContext.expected = count;
}
export function completeOneBotCronBatch(result) {
    const current = scope.getStore();
    if (current?.finalDelivery && result.status === 'sent') current.store.complete(current.id);
}
export function oneBotCronFinalContext(to, accountId) {
    const current = scope.getStore();
    if (!current?.finalDelivery || current.to !== to.replace(/^onebot:/u, '') || current.accountId !== (accountId ?? 'default')) return null;
    return current;
}
export async function sendOneBotCronFinal(current, send) {
    current.signal?.throwIfAborted();
    const run = current.runContext;
    let settle;
    const pending = new Promise(resolve => { settle = resolve; }); run.pending.add(pending);
    try {
        const result = await send({ signal: current.signal, rewritePersona: false, receiptDeliveryId:current.id,
            onPlatformDispatch: () => current.store.dispatched(current.id) });
        if (result.messageId) {
            current.store.receipt(current.id, result.messageId);
            run.accepted++;
            if (run.expected > 0 && run.accepted >= run.expected) current.store.complete(current.id);
        }
        return result;
    } finally { run.pending.delete(pending); settle(); }
}
