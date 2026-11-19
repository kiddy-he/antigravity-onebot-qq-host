import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {promisify} from 'node:util';
import {VOICE_TMP_DIR} from './voice-common.js';

const run=promisify(execFile);
async function convert(path,silk,log){
    const mp3=path.replace(/\.[^.]+$/u,'.mp3'),pcm=path.replace(/\.[^.]+$/u,'.pcm');
    try {
        let input=['-i',path];
        if(silk){
            const python=join(homedir(),'.local/share/onebot-voice-env/bin/python');
            const args=['-c','import pilk,sys; pilk.decode(sys.argv[1],sys.argv[2])',path,pcm];
            if(existsSync(python))await run(python,args,{timeout:15000});
            else await run('uv',['run','--with','pilk','python3',...args],{timeout:15000});
            input=['-f','s16le','-ar','24000','-ac','1','-i',pcm];
        }
        await run('ffmpeg',['-loglevel','error','-nostdin','-y',...input,'-ar','16000','-ac','1',mp3],{timeout:15000});
        if(dirname(path)===VOICE_TMP_DIR)await unlink(path).catch(()=>{});
        return mp3;
    }catch{log?.error?.('QQ voice conversion failed');return null;}
    finally{if(silk)await unlink(pcm).catch(()=>{});}
}
export const convertSilkToMp3=(path,log)=>convert(path,true,log);
export const convertAmrToMp3=(path,log)=>convert(path,false,log);
export function cleanupVoiceFiles(paths){
    for(const path of paths)if(dirname(path)===VOICE_TMP_DIR)unlink(path).catch(()=>{});
}
