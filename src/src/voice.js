import { isAmrFormat, isSilkFormat } from "./voice-common.js";
import { cleanupVoiceFiles, convertAmrToMp3, convertSilkToMp3 } from "./voice-convert.js";
import { downloadVoiceFile, ensureVoiceTmpDir } from "./voice-download.js";
import { inspectVoiceFile } from "./voice-inspect.js";
export { cleanupVoiceFiles, convertAmrToMp3, convertSilkToMp3, downloadVoiceFile, ensureVoiceTmpDir, isAmrFormat, isSilkFormat, };
import {realpath,readFile,stat,writeFile} from 'node:fs/promises';
import {join,extname,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {VOICE_TMP_DIR} from './voice-common.js';
import {getDefaultSharedDir,getDefaultContainerSharedDir} from './env.js';
async function stageVoice(value,account){
    const host=account?.config?.sharedDir??getDefaultSharedDir(),container=account?.config?.containerSharedDir??getDefaultContainerSharedDir();
    const local=value.replace(/^file:\/\//u,'');
    const source=await realpath(local.startsWith(container+sep)?join(host,local.slice(container.length+1)):local);
    if(!source.startsWith(await realpath(host)+sep))throw Error('Voice outside LLBot share');
    const info=await stat(source);
    if(!info.isFile() || info.size>16*1024*1024)throw Error('Invalid shared voice file');
    await ensureVoiceTmpDir();
    const suffix=extname(source);
    const file=join(VOICE_TMP_DIR,randomUUID()+(/^\.[a-z0-9]{1,5}$/iu.test(suffix)?suffix:'.ogg'));
    await writeFile(file,await readFile(source),{flag:'wx',mode:0o600});
    return file;
}
export async function processVoiceSegments(segments, log,account) {
    const results = [];
    for (const seg of segments) {
        const url = String(seg.data.url ?? seg.data.file ?? "");
        log?.info(`[voice] segment data: url=${seg.data.url}, file=${seg.data.file}, resolved=${url.slice(0, 200)}`);
        if (!url)
            continue;
        const filePath = url.startsWith("http")
            ? await downloadVoiceFile(url, log)
            : await stageVoice(url,account).catch(()=>null);
        if (!filePath)
            continue;
        const inspected = await inspectVoiceFile(filePath, log);
        if (inspected) {
            results.push(inspected);
        }
    }
    return results;
}
