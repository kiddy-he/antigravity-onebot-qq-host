import {onebotPath as publicPath} from '../paths.js';
import {constants} from 'node:fs';
import {open,realpath,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonical,digest,operationStore} from '../access/operations.js';
import {processOwner} from './owner-grant.js';

export const maintenanceScript=publicPath("workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh");
const checksum=text=>createHash('sha256').update(text).digest('hex');
const execute=promisify(execFile);
const unsafe=/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

async function snapshot(file){
    if(await realpath(file)!==file)throw Error('维护文件路径已改变');
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
        const info=await handle.stat();
        if(!info.isFile()||info.size>1024*1024||await realpath('/proc/self/fd/'+handle.fd)!==file)throw Error('维护文件不可用');
        const data=await handle.readFile();
        if(data.length>1024*1024)throw Error('维护文件超出大小限制');
        return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);
    }finally{await handle.close();}
}

export function applyTextEdits(text,edits){
    if(!Array.isArray(edits)||!edits.length||edits.length>30||Buffer.byteLength(JSON.stringify(edits))>65536)throw Error('无效的修改批次');
    const spans=edits.map(edit=>{
        if(!edit || typeof edit!=='object' || Object.keys(edit).sort().join(',')!=='newText,oldText' ||
            typeof edit.oldText!=='string'||typeof edit.newText!=='string'||!edit.oldText||unsafe.test(edit.oldText)||unsafe.test(edit.newText))throw Error('修改项需要可审阅的原文和替换文字');
        const at=text.indexOf(edit.oldText);
        if(at<0 || text.indexOf(edit.oldText,at+1)>=0)throw Error('原文缺失或不唯一，请重新读取文件');
        return {at,end:at+edit.oldText.length,replacement:edit.newText};
    }).sort((a,b)=>a.at-b.at);
    let cursor=0,result='';
    for(const span of spans){
        if(span.at<cursor)throw Error('修改范围重叠');
        result+=text.slice(cursor,span.at)+span.replacement;cursor=span.end;
    }
    result+=text.slice(cursor);
    if(result===text)throw Error('没有内容变化');
    return result;
}

export async function proposeOwnerEdit({path,edits},identity,workspace,signal,{file=maintenanceScript,store=operationStore()}={}){
    if(typeof path!=='string' || resolve(workspace,path)!==file)throw Error('此入口只支持已登记的维护脚本');
    const owner=processOwner(identity),request=identity.actor.requestId;
    if(!request)throw Error('缺少原始 QQ 请求');
    const requestKey=digest([owner,String(request),file]),id=digest([requestKey,edits]);
    function reply(row){
        if(row.id!==id)throw Error('本条请求已有另一份修改草案');
        return {status:'pending_local_review',proposalId:id,baseSha256:row.base,resultSha256:row.desired,editCount:edits.length,
            message:'修改草案已保存。机主可在本机运行 node scripts/review-owner-edit.mjs '+id+' 查看完整补丁。当前脚本尚未修改。'};
    }
    signal.throwIfAborted();
    const existing=store.db.prepare('SELECT * FROM owner_edit_proposals WHERE request_key=?').get(requestKey);
    if(existing)return reply(existing);
    const before=await snapshot(file),after=applyTextEdits(before,edits);
    signal.throwIfAborted();
    store.db.prepare('INSERT OR IGNORE INTO owner_edit_proposals VALUES(?,?,?,?,?,?,?)').run(id,requestKey,owner,checksum(before),checksum(after),canonical(edits),Date.now());
    return reply(store.db.prepare('SELECT * FROM owner_edit_proposals WHERE request_key=?').get(requestKey));
}

// Invoked by the local review command. Never registered as a model or QQ tool.
export async function exportOwnerEdit(id,{file=maintenanceScript,store=operationStore()}={}){
    if(!/^[a-f0-9]{64}$/u.test(id))throw Error('无效的草案标识');
    const row=store.db.prepare('SELECT * FROM owner_edit_proposals WHERE id=?').get(id);
    if(!row)throw Error('找不到草案');
    const before=await snapshot(file);
    if(checksum(before)===row.desired)throw Error('当前脚本已与草案结果一致');
    if(checksum(before)!==row.base)throw Error('当前文件已变更，需要按新版本重新生成草案');
    const after=applyTextEdits(before,JSON.parse(row.edits));
    if(checksum(after)!==row.desired)throw Error('草案指纹校验失败');
    const directory=await mkdtemp(join(tmpdir(),'onebot-edit-review-'));
    try{
        const left=join(directory,'before'),right=join(directory,'after');
        await writeFile(left,before,{mode:0o600});await writeFile(right,after,{mode:0o600});
        try{await execute('/usr/bin/diff',['-u','--label','a/agy-proxy-diagnose.sh','--label','b/agy-proxy-diagnose.sh',left,right],{maxBuffer:2*1024*1024,timeout:12000});}
        catch(e){if(e.code===1 && typeof e.stdout==='string' && !unsafe.test(e.stdout))return e.stdout;throw Error('补丁无法安全显示');}
        throw Error('没有可显示的修改');
    }finally{await rm(directory,{recursive:true,force:true});}
}
