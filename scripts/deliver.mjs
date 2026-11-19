import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { onebotPath } from '../src/src/paths.js';
const [service, path] = process.argv.slice(2);
try {
    if (!['alas-monitor', 'alas-screenshot'].includes(service) || !path) throw new Error('invalid service');
    const config = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH || onebotPath('openclaw.json'), 'utf8'));
    const secret = (await readFile(onebotPath('secrets/onebot-delivery.key'), 'utf8')).trim();
    const targetId = process.env.ALAS_SCREENSHOT_TARGET_QQ;
    if (!/^[1-9][0-9]{4,19}$/u.test(targetId ?? '')) throw Error('Set ALAS_SCREENSHOT_TARGET_QQ');
    const body = { service, targetId,
        dedupeKey: process.env.ONEBOT_DELIVERY_ID ?? `${service}:${process.env.ONEBOT_OPERATION_ID ?? randomUUID()}`,
        ...(service === 'alas-monitor' ? { text: await readFile(path, 'utf8') } : { path }) };
    const response = await fetch(`http://127.0.0.1:${config.gateway?.port ?? 18789}/onebot/internal/deliver`, { method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json',
            ...(process.env.ONEBOT_METRICS_TURN?{'X-OneBot-Metrics-Turn':process.env.ONEBOT_METRICS_TURN}:{}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    const result = await response.json();
    if (!response.ok || result.state !== 'accepted') throw new Error(`delivery ${result.id ?? ''}: ${result.state ?? result.error ?? response.status}`);
    const messageId = result.receipt?.primaryPlatformMessageId ?? result.receipt?.platformMessageIds?.at(-1);
    if (!messageId) throw new Error('missing platform receipt');
    console.log(`STATUS=ok\nMESSAGE_ID=${messageId}\nDELIVERY_ID=${result.id}`);
} catch (error) { console.log(`STATUS=fail\nREASON=${String(error.message).slice(0, 300)}`); process.exitCode = 1; }
