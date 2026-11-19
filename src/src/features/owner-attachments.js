import {onebotPath as publicPath} from '../paths.js';
import {constants,statSync} from 'node:fs';
import {open,realpath,mkdir,mkdtemp,link,rm} from 'node:fs/promises';
import {join,normalize} from 'node:path';

export const ownerImageDirectory=publicPath('media/exports');
const ext=/\.(?:png|jpe?g|gif|webp|bmp)$/iu;

export function parseImageExport(command){
    if(typeof command!=='string'||command.length>4000||/[\r\n\0]/u.test(command))throw Error('无效的图片保存请求');
    const stages=command.split(' && ');
    if(stages.shift()!=='mkdir -p '+ownerImageDirectory || stages.pop()!=='ls -lh '+ownerImageDirectory || !stages.length||stages.length>16)
        throw Error('只支持将本轮图片保存到登记目录');
    const names=new Set();
    return stages.map(stage=>{
        const pair = new RegExp('^cp -n (/[A-Za-z0-9._/-]+) ' + RegExp.escape(ownerImageDirectory) + '/([A-Za-z0-9][A-Za-z0-9._-]{0,149})$', 'u').exec(stage);
        if(!pair||normalize(pair[1])!==pair[1]||!ext.test(pair[1])||!ext.test(pair[2])||names.has(pair[2]))
            throw Error('图片保存路径或名称无效');
        names.add(pair[2]);return {path:pair[1],name:pair[2]};
    });
}

export function imageGrants(paths,context,checkMedia){
    return paths.map(path=>{
        if(!context?.mediaPaths?.includes(path))throw Error('图片不属于本次消息');
        const s=statSync(checkMedia(path,context),{bigint:true});
        return {dev:String(s.dev),ino:String(s.ino),ctimeNs:String(s.ctimeNs)};
    });
}

export async function withGrantedImages(paths,grants,work){
    if(!Array.isArray(grants)||grants.length!==paths.length)throw Error('缺少本轮图片授权');
    const handles=[],files=[];
    try{
        for(const [i,path] of paths.entries()){
            const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
            handles.push(handle);
            const s=await handle.stat({bigint:true}),grant=grants[i];
            if(!s.isFile() || s.size>25n*1024n*1024n || await realpath('/proc/self/fd/'+handle.fd)!==path ||
                String(s.dev)!==grant?.dev || String(s.ino)!==grant.ino || String(s.ctimeNs)!==grant.ctimeNs)
                throw Error('本轮图片在核对期间发生变化');
            files.push({path,bytes:Number(s.size),mode:(s.mode & 0o777n).toString(8),modifiedAt:new Date(Number(s.mtimeMs)).toISOString()});
        }
        return await work(files,handles);
    }finally{await Promise.all(handles.map(handle=>handle.close()));}
}

export async function readGrantedImage(handle,grant,size){
    const {default:sharp}=await import('sharp');
    const bytes=Buffer.alloc(size);
    let used=0;
    while(used<size){
        const {bytesRead}=await handle.read(bytes,used,size-used,used);
        if(!bytesRead)break;
        used+=bytesRead;
    }
    if(used!==size||String((await handle.stat({bigint:true})).ctimeNs)!==grant.ctimeNs)throw Error('本轮图片在核对期间发生变化');
    const bitmap=bytes.length>=14 && bytes[0]===0x42 && bytes[1]===0x4d;
    const decoder=sharp(bytes,{limitInputPixels:36000000});
    const metadata=await decoder.metadata();
    const {width,height}=metadata;
    const format=metadata.format==='magick' && bitmap?'bmp':metadata.format;
    if(format==='bmp')await decoder.raw().toBuffer();
    if(!['png','jpeg','gif','webp','bmp'].includes(format)||!width||!height)throw Error('文件未识别为支持的栅格图片');
    return {bytes,format,width,height};
}

export async function saveOwnerImages(command,grants,directory=ownerImageDirectory){
    const copies=parseImageExport(command);
    return withGrantedImages(copies.map(item=>item.path),grants,async(files,handles)=>{
        await mkdir(directory,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
        const dir=await open(directory,constants.O_DIRECTORY|constants.O_RDONLY|constants.O_NOFOLLOW);
        const pinned='/proc/self/fd/'+dir.fd;
        let staging;
        try{
            if(await realpath(pinned)!==directory)throw Error('图片保存目录已改变');
            staging=await mkdtemp(join(pinned,'.onebot-images-'));
            for(const [i,copy] of copies.entries()){
                const {bytes}=await readGrantedImage(handles[i],grants[i],files[i].bytes);
                const stage=await open(join(staging,copy.name),'wx',0o600);
                try{await stage.writeFile(bytes);await stage.sync();}finally{await stage.close();}
            }
            const results=[];
            for(const {name} of copies){
                try{await link(join(staging,name),join(pinned,name));results.push({name,status:'saved'});}
                catch(error){if(error.code!=='EEXIST')throw error;results.push({name,status:'already_exists'});}
            }
            await dir.sync();return {directory,files:results};
        }finally{try{if(staging)await rm(staging,{recursive:true,force:true});}finally{await dir.close();}}
    });
}
