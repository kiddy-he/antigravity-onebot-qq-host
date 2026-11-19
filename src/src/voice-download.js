import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAmrFormat, isSilkFormat, VOICE_TMP_DIR } from "./voice-common.js";
export async function ensureVoiceTmpDir() {
    await mkdir(VOICE_TMP_DIR, { recursive: true, mode: 0o700 });
}
export async function downloadVoiceFile(url, log) {
    try {
        await ensureVoiceTmpDir();
        const response = await fetch(url,{signal:AbortSignal.timeout(15000)});
        if (!response.ok) {
            log?.error(`Voice download failed: ${response.status}`);
            return null;
        }
        const chunks=[];let count=0;
        for await(const chunk of response.body){
            count+=chunk.length;if(count>16*1024*1024)throw Error('Voice exceeds size limit');
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
            log?.error("Voice download returned empty file");
            return null;
        }
        const suffix = isSilkFormat(buffer) ? ".silk" : isAmrFormat(buffer) ? ".amr" : ".ogg";
        const filePath = join(VOICE_TMP_DIR, `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
        await writeFile(filePath, buffer,{mode:0o600,flag:'wx'});
        log?.debug?.(`Downloaded voice: ${filePath} (${buffer.length} bytes)`);
        return filePath;
    }
    catch (err) {
        log?.error(`Voice download error: ${err}`);
        return null;
    }
}
