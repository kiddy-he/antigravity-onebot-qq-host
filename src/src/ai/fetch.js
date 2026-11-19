import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {loadAiConfig} from './config.js';

// Streaming host-agent transport obeys the same provider configuration as task APIs.
export function createConfiguredAiFetch(fallback = globalThis.fetch,{getConfig=loadAiConfig,execute=spawn}={}) {
    return function (input, init = {}) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        const providers=Object.values(getConfig().providers).filter(p=>p.baseUrl&&url.href.startsWith(p.baseUrl.replace(/\/$/u,'')+'/')).sort((a,b)=>b.baseUrl.length-a.baseUrl.length);
        const provider=providers[0];if(!provider?.transport)return fallback.call(this,input,init);
        const transport=provider.transport;
        if(transport.tlsVerify===false)throw Error('Invalid AI transport');
        const inherited = typeof input === 'object' && !(input instanceof URL) ? input : {};
        const headers = new Headers(init.headers ?? inherited.headers);
        headers.set('accept-encoding', 'identity');
        const signal = init.signal ?? inherited.signal;
        const body = init.body ?? inherited.body;
        const method = init.method || inherited.method || 'GET';
        if (signal?.aborted) return Promise.reject(signal.reason);
        return new Promise((resolve, reject) => {
            const directory = mkdtempSync(join(tmpdir(), 'ai-fetch-headers-'));
            const headerFile = join(directory, 'headers');
            writeFileSync(headerFile, Array.from(headers, ([name, value]) => name + ': ' + value).join('\n') + '\n', { mode: 0o600 });
            const cleanupFile = () => rmSync(directory, { recursive: true, force: true });
            const args = ['--silent', '--show-error', '--no-buffer', '--include', '--suppress-connect-headers','--connect-timeout',String(Math.ceil((transport.connectTimeoutMs??10000)/1000)),'--max-time',String(Math.ceil((transport.requestTimeoutMs??180000)/1000)), '--request', method, '--header', '@' + headerFile];
            if(transport.mode==='proxy')args.push('--proxy',transport.proxyUrl,'--noproxy','');else if(transport.mode!=='environment')args.push('--noproxy','*');
            if(transport.family)args.push(transport.family===6?'-6':'-4');if(transport.caFile)args.push('--cacert',transport.caFile);
            if (body !== null && body !== undefined) args.push('--data-binary', '@-');
            args.push(url.href);
            const child = execute('/usr/bin/curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
            let pending = Buffer.alloc(0), controller, responseStarted = false, failed = false;
            const failure = error => {
                if (failed) return; failed = true; cleanupFile();
                signal?.removeEventListener('abort', abort);
                if (responseStarted) {try{controller.error(error);}catch{}} else reject(error);
                child.kill('SIGTERM');
            };
            const abort = () => failure(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            signal?.addEventListener('abort', abort, { once: true });
            child.on('error', () => failure(new Error('Configured AI transport could not start')));
            child.stderr.on('data', () => {});
            child.stdout.on('data', chunk => {
                if (failed) return;
                if (responseStarted) { controller.enqueue(new Uint8Array(chunk)); return; }
                pending = Buffer.concat([pending, chunk]);
                let index;
                while ((index = pending.indexOf('\r\n\r\n')) >= 0) {
                    const block = pending.subarray(0, index).toString('latin1');
                    pending = pending.subarray(index + 4);
                    const lines = block.split('\r\n');
                    const status = Number(/^HTTP\/\S+\s+(\d{3})/u.exec(lines.shift())?.[1]);
                    if (status >= 100 && status < 200) continue;
                    if (!(status >= 200 && status <= 599)) return failure(new Error('Configured AI transport returned invalid HTTP headers'));
                    const outputHeaders = new Headers();
                    for (const line of lines) { const colon = line.indexOf(':'); if (colon > 0) outputHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim()); }
                    outputHeaders.delete('transfer-encoding');
                    const empty=method==='HEAD'||[204,205,304].includes(status);
                    const stream = new ReadableStream({ start(value) { controller = value; }, cancel() { failed = true; cleanupFile(); signal?.removeEventListener('abort', abort); child.kill('SIGTERM'); } });
                    responseStarted = true; cleanupFile();
                    resolve(new Response(empty?null:stream, { status, headers: outputHeaders }));
                    if (pending.length) controller.enqueue(new Uint8Array(pending));
                    pending = Buffer.alloc(0);
                    break;
                }
                if (!responseStarted && pending.length > 128 * 1024) failure(new Error('AI HTTP headers exceed limit'));
            });
            child.on('close', code => {
                cleanupFile();
                signal?.removeEventListener('abort', abort);
                if (failed) return;
                if (code !== 0 || !responseStarted) return failure(new Error(`Configured AI transport failed (exit ${code})`));
                controller.close();
            });
            child.stdin.on('error', () => {});
            if (body?.getReader) { const source = Readable.fromWeb(body); source.on('error', failure); source.pipe(child.stdin); }
            else if (typeof body?.arrayBuffer === 'function') body.arrayBuffer().then(value => child.stdin.end(Buffer.from(value))).catch(failure);
            else child.stdin.end(body ?? undefined);
        });
    };
}
