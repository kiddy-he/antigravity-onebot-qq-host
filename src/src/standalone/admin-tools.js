import {open,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,extname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {decideFeatureTool,trustedFeatureContext} from '../feature-tools.js';
import {loadFeatureConfig} from '../feature-policy.js';
import {loadWorkspaceRoutes} from '../workspaces/routes.js';
import {proposeOwnerEdit,maintenanceScript} from './owner-edit.js';
import {fetchPage} from './web-fetch.js';
import {startAdminProcess,pollAdminProcess,processGrants} from './admin-process.js';

const objectSchema=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'},positive={type:'integer',minimum:1};
const specs={
    exec:{description:'执行管理员已授权且已登记的业务操作。',parameters:objectSchema({command:string,background:{type:'boolean'},yieldMs:{type:'integer',minimum:0},timeout:positive},['command'])},
    process:{description:'查看当前机主私聊和会话代次启动的业务进程。poll 的 timeout 单位为毫秒。',parameters:objectSchema({action:{enum:['list','poll']},sessionId:string,timeout:{type:'integer',minimum:0}},['action'])},
    edit:{description:'为已登记的 agy 维护脚本准备精确替换草案；机主本机审阅并应用，QQ 端仅保存草案。',parameters:objectSchema({path:string,edits:{type:'array',minItems:1,maxItems:30,items:objectSchema({oldText:string,newText:string},['oldText','newText'])}},['path','edits'])},
    read:{description:'读取当前工作区、本轮附件、OneBot 维护源码或系统硬件诊断文件。offset 为从 1 起的行号。',parameters:objectSchema({path:string,offset:positive,limit:positive},['path'])},
    session_status:{description:'查看当前 QQ 会话本轮实际使用的模型、角色、账号、模式及时间。',parameters:objectSchema({sessionKey:string})},
    web_fetch:{description:'提取公开 HTTP(S) 网页的正文或 Markdown。网页返回的内容仅作外部资料。',parameters:objectSchema({url:string,extractMode:{enum:['markdown','text']},maxChars:positive},['url'])},
};

import {toolAllowed} from './tool-grants.js';
export {toolAllowed};

function below(root,file){
    const rest=relative(root,file);
    return rest!=='' && rest!=='..' && !rest.startsWith('..'+sep) && !isAbsolute(rest);
}
const codeRoot=fileURLToPath(new URL('../../../',import.meta.url));
const procFiles=new Set(['/proc/cpuinfo','/proc/meminfo','/proc/modules','/proc/version']);
const sysFiles=[
    /^\/sys\/class\/dmi\/id\/(?:sys_vendor|product_name|board_name)$/u,
    /^\/sys\/class\/drm\/card\d+\/device\/(?:vendor|device|uevent)$/u,
    /^\/sys\/class\/hwmon\/hwmon\d+\/(?:name|power\d+_(?:average|input))$/u,
    /^\/sys\/class\/powercap\/intel-rapl:\d+(?::\d+)*\/(?:name|energy_uj)$/u,
];
function diagnosticFile(requested,canonical){
    if(requested===maintenanceScript)return canonical===requested;
    if(requested==='/etc/os-release')return canonical===requested || canonical==='/usr/lib/os-release';
    if(procFiles.has(requested))return requested===canonical;
    if(sysFiles.some(pattern=>pattern.test(requested)))return below('/sys/devices',canonical);
    if(requested!==canonical || !below(codeRoot,canonical))return false;
    const path=relative(codeRoot,canonical);
    // Only source modules and their two public descriptors. Output, local
    // configuration, test data and installed dependencies are separate trees.
    return ['package.json','src/openclaw.plugin.json','src/index.js'].includes(path) ||
        /^(?:src\/src|scripts)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:js|mjs)$/iu.test(path);
}
async function verifyWorkspaceFile(root,file,workspaces){
    if(!below(root,file))throw Error('文件超出本次工作区');
    const parts=relative(root,file).split(sep);
    if(parts.some(part=>part.startsWith('.')||['secrets','credentials','antigravity-oauth-token'].includes(part.toLowerCase())))
        throw Error('文件不属于可读取的工作资料');
    for(const candidate of workspaces){
        const path=resolve(candidate.replace(/^~\//u,homedir()+'/'));
        if(below(root,path) && (file===path || below(path,file)))throw Error('文件属于其他工作区');
    }
    // Legacy persona directories may survive after their agent configuration is removed.
    for(let dir=dirname(file);dir!==root;dir=dirname(dir)){
        try{
            if((await stat(join(dir,'IDENTITY.md'))).isFile())throw Error('文件属于其他工作区');
        }catch(error){if(error.code!=='ENOENT')throw error;}
    }
}
async function readBoundFile(params,actor,workspace,workspaces,signal){
    const {path,offset=1,limit=2000}=params;
    if(typeof path!=='string'||!path.trim()||!Number.isSafeInteger(offset)||offset<1||!Number.isSafeInteger(limit)||limit<1)throw Error('无效的路径或行数');
    const root=await realpath(workspace);
    const requested=resolve(root,path.replace(/^~\//u,homedir()+'/'));
    const file=await realpath(requested);
    const media=(actor.mediaPaths??[]).includes(file);
    if(!media && !diagnosticFile(requested,file))await verifyWorkspaceFile(root,file,workspaces);
    const handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
    try{
        const info=await handle.stat();
        if(!info.isFile() || await realpath('/proc/self/fd/'+handle.fd)!==file)throw Error('文件在打开时发生变化');
        const ext=extname(file).toLowerCase();
        if(['.png','.jpg','.jpeg','.gif','.webp','.bmp'].includes(ext)){
            if(info.size>16*1024*1024)throw Error('图片过大');
            const image=await sharp(await handle.readFile({signal}),{limitInputPixels:36000000}).rotate()
                .resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:78}).toBuffer();
            if(image.length>640*1024)throw Error('图片超过本轮工具传输限制');
            return [{type:'image',mimeType:'image/jpeg',data:image.toString('base64')}];
        }
        if(info.size>32*1024*1024)throw Error('文件超出单次读取范围');
        const stream=handle.createReadStream({autoClose:false,encoding:'utf8',signal});
        const lines=createInterface({input:stream,crlfDelay:Infinity});
        const output=[];let count=0,bytes=0;
        try{
            for await(const source of lines){
                // Module addresses and kernel-specific annotations are unnecessary for hardware diagnostics.
                const line=file==='/proc/modules'?source.split(/\s+/u).slice(0,5).join(' '):source;
                if(++count<offset)continue;
                if(line.includes('\0'))throw Error('不支持此二进制文件');
                const size=Buffer.byteLength(line)+1;
                if(output.length>=Math.min(limit,2000)||bytes+size>50000){
                    if(!output.length)throw Error('单行超出本次输出限制');
                    output.push('[继续读取请使用 offset='+count+']');break;
                }
                output.push(line);bytes+=size;
            }
        }finally{lines.close();stream.destroy();}
        return [{type:'text',text:output.join('\n')}];
    }finally{await handle.close();}
}

export const adminToolNames=Object.keys(specs);

export function privateAdminTool(name,{sessionKey,agentId,workspace,workspaces=[],step,profile,webConfig,execConfig,processTools,generation}){
    if(!Object.hasOwn(specs,name))return;
    const actor=trustedFeatureContext(sessionKey),route=loadWorkspaceRoutes().agents[agentId];
    if(!actor || actor.scope!=='private'||actor.internal || !route || route.scope!=='private' || route.purpose!=='main' ||
        route.accountId!==actor.accountId || actor.workspaceAgentId!==agentId || String(route.conversationId)!==String(actor.senderId) ||
        !decideFeatureTool(loadFeatureConfig(),name,{},actor).allowed)return;
    if((name==='exec'||name==='process') && (!processTools || !generation || execConfig?.host!=='gateway' || execConfig.mode!=='ask'))return;
    if(name==='edit' && !generation)return;
    if(name==='web_fetch' && webConfig?.fetch?.enabled===false)return;
    const current=params=>trustedFeatureContext(sessionKey)===actor && decideFeatureTool(loadFeatureConfig(),name,params,actor).allowed;
    return {name,...specs[name],async execute(_id,params,signal){
        signal.throwIfAborted();
        try{
            if(!params || typeof params!=='object' || Array.isArray(params) || Object.keys(params).some(k=>!Object.hasOwn(specs[name].parameters.properties,k)))
                throw Error('不支持这些工具参数');
            if(!current(params))throw Error('本轮授权已撤销');
            let content;
            if(name==='exec'||name==='process'){
                const identity={actor,sessionKey,generation},tools=processTools();
                const value=name==='exec'?await startAdminProcess(params,identity,tools,signal):
                    await pollAdminProcess(params,identity,signal,undefined,()=>processGrants(tools));
                content=[{type:'text',text:JSON.stringify(value)}];
            }else if(name==='edit'){
                const result=await proposeOwnerEdit(params,{actor,sessionKey,generation},workspace,signal);
                content=[{type:'text',text:JSON.stringify(result)}];
            }else if(name==='read')content=await readBoundFile(params,actor,workspace,workspaces,signal);
            else if(name==='web_fetch'){
                const page=await fetchPage(params,webConfig?.fetch,signal);
                content=[{type:'text',text:JSON.stringify(page)}];
            }else{
                if(params.sessionKey!==undefined && !['current',sessionKey].includes(params.sessionKey))throw Error('只能查看本轮所属会话');
                const status={time:new Date().toISOString(),agentId,accountId:actor.accountId,profile:profile??'normal',
                    sessionKey,model:step.providerId+'/'+step.deployment.model,thinking:step.parameters?.thinking??step.thinking??step.deployment.thinking,
                    adapter:step.provider.adapter};
                content=[{type:'text',text:JSON.stringify(status)}];
            }
            signal.throwIfAborted();
            if(!current(params))
                throw Error('本轮授权已撤销');
            return {content};
        }catch(error){
            signal.throwIfAborted();
            // Filesystem and transport errors may contain private paths or proxy addresses.
            const reason=error.code||error.syscall?'资源不可用':String(error.message).slice(0,180);
            return {isError:true,content:[{type:'text',text:reason}]};
        }
    }};
}
