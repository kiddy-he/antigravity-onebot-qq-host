import {loadAiConfig} from './ai/config.js';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { X509Certificate, createHash } from 'node:crypto';
import { onebotPath } from './paths.js';

let cached;
export function loadGeminiTransport() {
    let profile;
    try {
        if(process.env.ONEBOT_GEMINI_TRANSPORT_PROFILE)profile=JSON.parse(readFileSync(process.env.ONEBOT_GEMINI_TRANSPORT_PROFILE,'utf8'));
        else {
            const provider=Object.values(loadAiConfig().providers).find(p=>p.transport?.caFile&&p.transport?.certificateSha256);
            if(!provider)return undefined;
            profile={origin:new URL(provider.baseUrl).origin,family:provider.transport.family,certificateFile:provider.transport.caFile,certificateSha256:provider.transport.certificateSha256};
        }
    }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if(cached&&JSON.stringify(cached.profile)===JSON.stringify(profile))return cached;
    cached?.agent?.destroy();
    const origin = new URL(profile.origin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || profile.family !== 6)
        throw new Error('Invalid trusted Gemini transport profile');
    const ca = readFileSync(profile.certificateFile, 'utf8');
    const fingerprint = createHash('sha256').update(new X509Certificate(ca).raw).digest('hex');
    if (fingerprint !== profile.certificateSha256) throw new Error('Trusted Gemini certificate fingerprint mismatch');
    const connect = { family: 6, autoSelectFamily: false, ca, rejectUnauthorized: true,
        checkServerIdentity(hostname, certificate) {
            if (hostname !== origin.hostname || !certificate.raw || createHash('sha256').update(certificate.raw).digest('hex') !== fingerprint)
                return new Error('Gemini server certificate does not match the trusted certificate');
            // This explicitly trusted appliance certificate has a different CN.
            // The chain and exact pinned certificate remain verified.
        } };
    cached = { origin: origin.origin, connect, agent: new https.Agent({ ...connect, keepAlive: true }), profile };
    return cached;
}
export function trustedGeminiRequestOptions(url) {
    const target = typeof url === 'string' ? new URL(url) : url;
    const transport = loadGeminiTransport();
    return transport && target.origin === transport.origin ? { ...transport.connect, agent: transport.agent } : {};
}

// An HTTPS-backed Fetch implementation also works in runtimes whose bundled
// Fetch and installed Undici use incompatible dispatcher protocols.
export function createTrustedGeminiFetch(fallback = globalThis.fetch) {
    return function (input, init = {}) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        const transport = loadGeminiTransport();
        if (!transport || url.origin !== transport.origin) return fallback.call(this, input, init);
        const inherited = typeof input === 'object' && !(input instanceof URL) ? input : {};
        const method = init.method || inherited.method || 'GET';
        const headers = new Headers(init.headers ?? inherited.headers);
        headers.set('accept-encoding', 'identity');
        const signal = init.signal ?? inherited.signal;
        const body = init.body ?? inherited.body;
        return new Promise((resolve, reject) => {
            let response;
            const request = https.request(url, { method, headers: Object.fromEntries(headers), ...trustedGeminiRequestOptions(url) });
            const abort = () => { const error = signal.reason ?? new DOMException('Aborted', 'AbortError'); response?.destroy(error); request.destroy(error); };
            const cleanup = () => signal?.removeEventListener('abort', abort);
            signal?.addEventListener('abort', abort, { once: true });
            request.on('error', error => { cleanup(); reject(error); });
            request.on('response', async res => {
                response = res;
                res.on('end', cleanup); res.on('close', cleanup);
                const { Readable } = await import('node:stream');
                const { createGunzip, createInflate, createBrotliDecompress } = await import('node:zlib');
                const outputHeaders = new Headers();
                for (const [name, value] of Object.entries(res.headers)) {
                    if (Array.isArray(value)) for (const item of value) outputHeaders.append(name, item);
                    else if (value !== undefined) outputHeaders.set(name, value);
                }
                let stream = res;
                const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[res.headers['content-encoding']];
                if (decoder) { stream = res.pipe(decoder()); res.on('error', error => stream.destroy(error)); outputHeaders.delete('content-encoding'); outputHeaders.delete('content-length'); }
                const empty = method === 'HEAD' || [204, 205, 304].includes(res.statusCode);
                if (empty) res.resume();
                resolve(new Response(empty ? null : Readable.toWeb(stream), { status: res.statusCode, statusText: res.statusMessage, headers: outputHeaders }));
            });
            if (signal?.aborted) { abort(); return; }
            (async () => {
                if (!body) request.end();
                else if (typeof body?.getReader === 'function') {
                    const { Readable } = await import('node:stream');
                    const source = Readable.fromWeb(body); source.on('error', error => request.destroy(error)); source.pipe(request);
                } else if (typeof body?.arrayBuffer === 'function') request.end(Buffer.from(await body.arrayBuffer()));
                else request.end(body);
            })().catch(error => request.destroy(error));
        });
    };
}
