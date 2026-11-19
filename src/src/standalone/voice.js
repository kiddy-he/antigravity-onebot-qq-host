import {execFile} from 'node:child_process';
import {readFile,realpath,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {VOICE_TMP_DIR} from '../voice-common.js';

const script=fileURLToPath(new URL('../../../scripts/transcribe-voice.py',import.meta.url));
export async function transcribeVoice(path,signal){
    const dir=await realpath(VOICE_TMP_DIR),file=await realpath(path);
    if(dirname(file)!==dir || !(await stat(file)).isFile() || (await stat(file)).size>16*1024*1024)
        throw Error('Untrusted voice input');
    const bytes=await readFile(file);
    const python=process.env.ONEBOT_WHISPER_PYTHON??'python3';
    return new Promise((resolve,reject)=>{
        const child=execFile(python,[script],{signal,timeout:120000,maxBuffer:65536,
            env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin',OMP_NUM_THREADS:'2',HF_HUB_OFFLINE:'1'}},(error,stdout)=>{
            if(error){reject(Error('Local voice transcription failed'));return;}
            try{resolve(JSON.parse(stdout).text);}catch{reject(Error('Invalid transcription response'));}
        });
        child.stdin.on('error',()=>{});child.stdin.end(bytes);
    });
}
