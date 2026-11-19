// Deterministic local typesetting. No user code, browser login profile or network is used.
import MarkdownIt from 'markdown-it';
import katex from 'katex';
import 'katex/contrib/mhchem';
import puppeteer from 'puppeteer-core';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, writeFile, mkdir, readdir, rm, stat, chmod, rename} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {onebotPath} from './paths.js';

const run = promisify(execFile), require = createRequire(import.meta.url);
const VERSION = 'academic-v3';
export const ACADEMIC_ANSWER_INSTRUCTION = '\n[学术回答排版] 本轮需要完整的学术解答；保留问题条件、步骤、推导、公式、结论和必要说明。直接输出完整回答，可用 Markdown 和标准 LaTeX，行内用 \\(…\\) 或 $…$，独立公式用 \\[…\\] 或 $$…$$，不得把上下标、分式手工压成普通字符。宿主会把整个回答排成带公式的图片；无需调用生图、exec 或写文件工具，也无需请求审批。不要省略步骤或只输出图片占位。\n';

function delimiters(source, pos) {
    if (source.startsWith('$$', pos)) return ['$$', '$$', true];
    if (source.startsWith('\\[', pos)) return ['\\[', '\\]', true];
    if (source.startsWith('\\(', pos)) return ['\\(', '\\)', false];
    if (source[pos] === '$' && !/\s/u.test(source[pos + 1] ?? ' ')) return ['$', '$', false];
}
function mathEnd(source, start, close) {
    let end = start;
    while ((end = source.indexOf(close, end)) >= 0) {
        let slashes = 0;
        for (let i = end - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
        if (slashes % 2 === 0) return end;
        end += close.length;
    }
    return -1;
}
function makeMarkdown(warnings = []) {
    const md = new MarkdownIt({html:false, linkify:false, typographer:false});
    md.inline.ruler.before('escape', 'academic_math', (state, silent) => {
        const pair = delimiters(state.src, state.pos);
        if (!pair) return false;
        const [open, close, display] = pair, start = state.pos + open.length;
        const end = mathEnd(state.src, start, close);
        if (end < start || end === start || (open === '$' && /\s/u.test(state.src[end - 1]))) return false;
        if (!silent) {const token = state.push('academic_math', '', 0); token.content = state.src.slice(start, end); token.meta = {display, open};}
        state.pos = end + close.length;
        return true;
    });
    md.block.ruler.before('fence', 'academic_math_block', (state, startLine, endLine, silent) => {
        const start = state.bMarks[startLine] + state.tShift[startLine];
        const pair = delimiters(state.src, start);
        if (!pair?.[2]) return false;
        const [open, close] = pair, end = mathEnd(state.src, start + open.length, close);
        if (end < 0) return false;
        let next = startLine;
        while (next < endLine && state.eMarks[next] < end + close.length) next++;
        if (next >= endLine || state.src.slice(end + close.length, state.eMarks[next]).trim()) return false;
        if (silent) return true;
        const token = state.push('academic_math_block', '', 0);
        token.block = true; token.content = state.src.slice(start + open.length, end); token.meta = {display:true, open};
        token.map = [startLine, next + 1]; state.line = next + 1; return true;
    });
    const renderMath = (tokens, idx) => {
        const token = tokens[idx];
        try {
            const rendered = katex.renderToString(token.content, {displayMode:token.meta.display, throwOnError:true,
                trust:false, strict:'ignore', maxExpand:300, maxSize:20, output:'htmlAndMathml'});
            return `<${token.meta.display ? 'div' : 'span'} class="${token.meta.display ? 'math-display' : 'math-inline'}">${rendered}</${token.meta.display ? 'div' : 'span'}>`;
        } catch {
            warnings.push({kind:'formula-parse', index:idx});
            return `<code class="formula-error">${md.utils.escapeHtml(token.meta.open + token.content + (token.meta.open === '\\[' ? '\\]' : token.meta.open === '\\(' ? '\\)' : token.meta.open))}</code>`;
        }
    };
    md.renderer.rules.academic_math = renderMath;
    md.renderer.rules.academic_math_block = renderMath;
    md.renderer.rules.image = (tokens, idx) => `<span>[图片：${md.utils.escapeHtml(tokens[idx].content || '参考图片')}]</span>`;
    // Links are readable text, never clickable or fetched by the renderer.
    md.renderer.rules.link_open = () => '<span class="link">';
    md.renderer.rules.link_close = (tokens, idx) => {
        for(let i=idx-1;i>=0;i--){if(tokens[i].type==='link_open')return `</span>（${md.utils.escapeHtml(tokens[i].attrGet('href') ?? '')}）`;}return '</span>';
    };
    return md;
}
export function hasAcademicFormula(text) {
    const inspect = tokens => tokens.some(token => (['academic_math','academic_math_block'].includes(token.type)
        && (token.meta.display || /\\[a-zA-Z]+|[_^=]|[+−×÷∑∫]/u.test(token.content))) || (token.children && inspect(token.children)));
    return inspect(makeMarkdown().parse(String(text ?? ''), {}));
}
export function shouldRenderAcademicAnswer({final = false, answerFormat = 'text', text = ''} = {}) {
    return final && Boolean(String(text).trim()) && (answerFormat === 'academic_image' || hasAcademicFormula(text));
}
let cssPromise;
async function embeddedKatexCss() {
    return cssPromise ??= (async () => {
        const root = dirname(require.resolve('katex/package.json'));
        let css = await readFile(join(root, 'dist/katex.min.css'), 'utf8');
        const replacements = await Promise.all([...new Set(css.match(/url\([^)]*\)/gu))].map(async value => {
            const file = value.slice(4, -1).replace(/["']/gu, '');
            const data = await readFile(join(root, 'dist', file));
            const mime = file.endsWith('woff2') ? 'font/woff2' : file.endsWith('woff') ? 'font/woff' : 'font/ttf';
            return [value, `url(data:${mime};base64,${data.toString('base64')})`];
        }));
        for (const [before, after] of replacements) css = css.replaceAll(before, after);
        return css;
    })();
}
export async function academicHtml(text) {
    const warnings = [], md = makeMarkdown(warnings), content = md.render(text);
    return {warnings, html:`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"><style>${await embeddedKatexCss()}
        *{box-sizing:border-box}html{font-size:27px}body{margin:0;color:#252638;font-family:'Noto Sans CJK SC','WenQuanYi Zen Hei',sans-serif;line-height:1.65;overflow-wrap:anywhere}
        h1,h2,h3,h4,h5,h6{color:#824b78;line-height:1.4;break-after:avoid;margin:1em 0 .45em}h1{font-size:1.55rem}h2{font-size:1.35rem}h3,h4{font-size:1.15rem}
        p{margin:.55em 0;orphans:3;widows:3}ul,ol{padding-left:1.5em}li{margin:.3em 0}blockquote{border-left:5px solid #e6c6df;padding:0 1em;margin:.6em 0;color:#555}
        pre{break-inside:avoid;white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f3f8;padding:18px;font-size:.8rem}code{font-family:monospace}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border:1px solid #dccfdd;padding:10px}tr{break-inside:avoid}
        .math-inline{display:inline-block;vertical-align:baseline;max-width:100%}.math-display{margin:.7em 0;text-align:center;break-inside:avoid}.katex-display{margin:0}.katex{font-size:1.15em}.formula-error{white-space:pre-wrap;color:#8b253c}.link{color:#536f95}hr{border:0;border-top:1px solid #e6dce6}
        </style></head><body>${content}</body></html>`};
}
let active = 0;
const pending = [];
async function slot(signal) {
    if (active < 2) {active++; return;}
    await new Promise((resolve, reject) => {
        const entry = {resolve:() => {signal?.removeEventListener('abort', abort);resolve();}};
        const abort = () => {const index = pending.indexOf(entry); if (index >= 0) pending.splice(index, 1);reject(signal.reason);};
        pending.push(entry); signal?.addEventListener('abort', abort, {once:true}); if (signal?.aborted) abort();
    });
}
function release() {const next = pending.shift(); if (next) next.resolve(); else active--;}
export async function cleanupAcademicImages(root, now = Date.now()) {
    await mkdir(root,{recursive:true,mode:0o700});
    for (const name of await readdir(root)) {
        if (!/^(?:[a-f0-9]{64}|\.render-[a-f0-9-]{36})$/u.test(name)) continue;
        const path = join(root,name);
        if (now - (await stat(path)).mtimeMs > 86400000) await rm(path,{recursive:true,force:true});
    }
}
export async function renderAcademicAnswer(text, {root = onebotPath('state/academic-answer-images'), signal, executablePath = '/snap/bin/chromium', keepPdf = false} = {}) {
    text = String(text ?? '');
    if (!text.trim() || text.length > 120000) throw new Error('学术回答排版长度超限，未截断回答');
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]);
    bounded.throwIfAborted(); await slot(bounded);
    let browser, temporary;
    const started = Date.now(), hash = createHash('sha256').update(VERSION + text).digest('hex'), destination = join(root,hash);
    try {
        await cleanupAcademicImages(root);
        try {
            const cached = JSON.parse(await readFile(join(destination,'manifest.json'),'utf8'));
            const pages = cached.files.map(file => join(destination,file));
            if (!pages.length || pages.length > 64) throw new Error('invalid cache');
            await Promise.all(pages.map(path => stat(path)));
            return {...cached,pages,cached:true,elapsedMs:Date.now()-started};
        } catch {}
        temporary = join(root,`.render-${randomUUID()}`); await mkdir(temporary,{mode:0o700});
        const {html,warnings} = await academicHtml(text);
        bounded.throwIfAborted();
        browser = await puppeteer.launch({executablePath,headless:true,pipe:true,timeout:15000,
            args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-extensions']});
        const abort = () => {void browser?.close().catch(()=>{});};
        bounded.addEventListener('abort',abort,{once:true});
        try {
            const page = await browser.newPage();
            await page.setRequestInterception(true);
            page.on('request',request => {if (/^(?:data:|about:)/u.test(request.url())) void request.continue(); else void request.abort();});
            await page.setViewport({width:1072,height:1900,deviceScaleFactor:1});
            await page.setContent(html,{waitUntil:'load',timeout:15000});
            await page.evaluate(async () => {
                await document.fonts.ready;
                // Fit whole display formulas to the page width without clipping fractions or matrices.
                for(const element of document.querySelectorAll('.math-display > .katex-display, .math-inline')) {
                    let size = parseFloat(getComputedStyle(element).fontSize);
                    for(let i=0;i<5 && (element.scrollWidth>element.clientWidth+1 || element.scrollHeight>1500);i++) {
                        size*=Math.min(element.clientWidth/element.scrollWidth,1500/element.scrollHeight)*.98;element.style.fontSize=`${size}px`;
                    }
                }
            });
            const pageHeight = await page.evaluate(() => Math.min(1900,Math.max(480,Math.ceil(document.body.getBoundingClientRect().height)+180)));
            await page.pdf({path:join(temporary,'answer.pdf'),width:'1200px',height:`${pageHeight}px`,printBackground:true,
                margin:{top:'64px',bottom:'70px',left:'64px',right:'64px'},displayHeaderFooter:true,
                headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:15px;text-align:center;width:100%;color:#8b7788">学术解答 · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',timeout:30000});
        } finally {bounded.removeEventListener('abort',abort); await browser.close();browser=undefined;}
        bounded.throwIfAborted();
        // Bound page count before rasterization: preserve full answer, or explicitly fall back.
        const {stdout:info} = await run('/usr/bin/pdfinfo',[join(temporary,'answer.pdf')],{signal:bounded,timeout:10000});
        const count = Number(/^Pages:\s+(\d+)/mu.exec(info)?.[1]);
        if (!count || count>64) throw new Error('学术回答分页超限，未截断回答');
        await run('/usr/bin/pdftoppm',['-png','-r','96',join(temporary,'answer.pdf'),join(temporary,'page')],{signal:bounded,timeout:60000,maxBuffer:1024*1024});
        const files = (await readdir(temporary)).filter(file=>/^page-\d+\.png$/u.test(file)).sort((a,b)=>Number(a.match(/\d+/u)[0])-Number(b.match(/\d+/u)[0]));
        if(files.length!==count) throw new Error('学术回答分页不完整');
        for (const file of files) await chmod(join(temporary,file),0o600);
        if(!keepPdf) await rm(join(temporary,'answer.pdf'));
        const manifest = {version:VERSION,files,pageCount:count,sourceChars:text.length,warnings};
        await writeFile(join(temporary,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
        try {await rename(temporary,destination);temporary=undefined;} catch(error) {if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
        return {...manifest,pages:files.map(file=>join(destination,file)),cached:false,elapsedMs:Date.now()-started};
    } finally {await browser?.close().catch(()=>{});if(temporary)await rm(temporary,{recursive:true,force:true});release();}
}
