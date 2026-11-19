import { analyzeMarketRequest } from './sharemarket-analysis.js';
import { normalizeMarketCatalogue,marketReadHint } from './sharemarket-symbols.js';
import { readPreparedMarketNews } from './sharemarket-news-cache.js';
import { rewriteMarketText } from './sharemarket-persona.js';
import { requireMarketCommand } from './sharemarket-command.js';
import { readFile, mkdir, writeFile, realpath, open, chmod } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { onebotPath } from '../paths.js';
import { loadFeatureConfig, featureIdentity, authorizeFeature, outboundTargetAllowed, automationFeatureEnabled } from '../feature-policy.js';
import { loadServiceRegistry } from '../access/services.js';
export function splitMarketText(text) {
    const parts=[];
    while(text.length>4400){
        let end=text.lastIndexOf('\n',4400);if(end<2200)end=4400;
        if(/[\uD800-\uDBFF]/u.test(text[end-1]))end--;
        parts.push(text.slice(0,end));text=text.slice(end);
    }
    if(text)parts.push(text);
    return parts;
}
const starts=new Map();
const deliveryLanes=new WeakMap();
async function serializeDelivery(queue,key,run) {
    const lanes=deliveryLanes.get(queue)??new Map();deliveryLanes.set(queue,lanes);
    const pending=(lanes.get(key)??Promise.resolve()).catch(()=>{}).then(run);lanes.set(key,pending);
    try{return await pending;}finally{if(lanes.get(key)===pending)lanes.delete(key);}
}
const safeName=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,39}$/u.test(value);
export async function loadMarketConfig(path=onebotPath('onebot-sharemarket.json')) {
    const config=JSON.parse(await readFile(path,'utf8'));
    if(config.version!==1||typeof config.enabled!=='boolean'||!config.markets||typeof config.markets!=='object'||Array.isArray(config.markets)||!config.groups||typeof config.groups!=='object'||Array.isArray(config.groups))throw new Error('股市配置无效。');
    for(const [id,market] of Object.entries(config.markets)) if(!safeName(id)||typeof market.enabled!=='boolean'||market.options!==undefined&&(!market.options||typeof market.options!=='object'||Array.isArray(market.options)))throw new Error('市场定义无效。');
    if(!safeName(config.privateMarket)||!config.markets[config.privateMarket])throw new Error('股市私聊市场无效。');
    for(const [id,market] of Object.entries(config.groups)) if(!/^[1-9][0-9]{4,19}$/u.test(id)||!config.markets[market])throw new Error('股市群绑定无效。');
    if(config.news!==undefined){
        if(!config.news||typeof config.news.enabled!=='boolean'||!config.news.routes||typeof config.news.routes!=='object'||Array.isArray(config.news.routes))throw new Error('股市新闻配置无效。');
        for(const [id,route] of Object.entries(config.news.routes))if(!/^[a-f0-9-]{36}$/u.test(id)||!route||typeof route.enabled!=='boolean'||!config.markets[route.marketId]||config.groups[route.groupId]!==route.marketId||typeof route.accountId!=='string')throw new Error('股市新闻路由无效。');
    }
    return config;
}
/** Public symbols only; caller resolves and authorizes the actual conversation first. */
export async function loadMarketIntentCatalogue(config,id,{rpc=marketRpc,ensure=ensureMarketService,signal}={}) {
    if(!config.enabled||!config.markets[id]?.enabled)throw new Error('market_catalogue_unavailable');
    const {socket}=await ensure(config,id,{rpc});
    const response=await rpc(socket,{method:'catalogue'},{timeoutMs:5000,signal});
    if(!response.ok||response.market_id!==id)throw new Error('market_catalogue_unavailable');
    return normalizeMarketCatalogue(response);
}
export function resolveMarket(config,context) {
    if(!config.enabled)throw new Error('股市尚未启用。');
    const id=context.scope==='group'?config.groups[String(context.groupId)]:config.privateMarket;
    if(!safeName(id)||!config.markets[id]?.enabled)throw new Error('当前会话未绑定已启用的市场。');
    return id;
}
export function marketRpc(socketPath,input,{timeoutMs=120000,signal}={}) {
    return new Promise((resolvePromise,reject)=>{
        const socket=createConnection(socketPath);socket.setEncoding('utf8');let buffer='',settled=false;
        const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolvePromise(value);};
        const abort=()=>finish(signal.reason??new Error('market request cancelled'));
        const timer=setTimeout(()=>finish(new Error('market_timeout_uncertain')),timeoutMs);
        if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
        socket.once('connect',()=>socket.write(JSON.stringify(input)+'\n'));
        socket.on('error',error=>finish(error));
        socket.on('end',()=>{if(!settled)finish(new Error('market_connection_ended_uncertain'));});
        socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>1024*1024)return finish(new Error('market_output_too_large'));const end=buffer.indexOf('\n');if(end>=0){try{finish(null,JSON.parse(buffer.slice(0,end)));}catch{finish(new Error('invalid_market_response'));}}});
    });
}
export async function ensureMarketService(config,id,{rpc=marketRpc}={}) {
    const root=resolve(config.stateRoot??onebotPath('state/sharemarket')),state=join(root,id),socket=join(state,'runtime.sock');
    try{const health=await rpc(socket,{method:'health'},{timeoutMs:700});const expected=createHash('sha256').update(JSON.stringify(config.markets[id].options??{})).digest('hex');if(health.options_hash&&health.options_hash!==expected)throw new Error('股市配置已变更，请通过管理脚本平滑重启对应市场。');return {socket,state};}catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;}
    if(starts.has(socket))return starts.get(socket);
    const pending=(async()=>{
        await mkdir(state,{recursive:true,mode:0o700});await chmod(state,0o700);
        const options=join(state,'options.json');await writeFile(options,JSON.stringify(config.markets[id].options??{}),{mode:0o600});
        const source=resolve(config.sourceRoot??onebotPath('onebot-onebot-custom/integrations/sharemarket'));
        const python=config.python??join(root,'.venv/bin/python');
        const log=await open(join(state,'runtime.log'),'a',0o600);
        const child=spawn(python,['-m','astrbot_plugin_sharemarket.runtime','serve','--state-dir',state,'--market-id',id,'--config',options],{cwd:source,env:{...process.env,PYTHONPATH:source,PYTHONUNBUFFERED:'1'},stdio:['ignore',log.fd,log.fd],detached:true});
        let spawnError;child.once('error',e=>{spawnError=e;});child.unref();await log.close();
        for(let attempt=0;attempt<80;attempt++) {
            if(spawnError)throw new Error('股市Python运行环境不可用，请检查本机配置。');
            try{await rpc(socket,{method:'health'},{timeoutMs:500});return {socket,state};}catch{}
            await new Promise(r=>setTimeout(r,100));
        }
        throw new Error('股市启动失败，请检查本地运行日志。');
    })();starts.set(socket,pending);try{return await pending;}finally{starts.delete(socket);}
}
export function trustedMarketActor(context,policy=loadFeatureConfig()) {
    if(context.actorType==='service')throw new Error('定时任务需使用独立的股市播报入口，不能冒充玩家。');
    if(!/^[1-9][0-9]{4,19}$/u.test(String(context.senderId)))throw new Error('missing trusted player');
    return {senderId:String(context.senderId),accountId:context.accountId,scope:context.scope,...(context.scope==='group'?{groupId:String(context.groupId)}:{}),identity:featureIdentity(policy,context),nickname:String(context.senderName??context.nickname??context.senderId).slice(0,80)};
}
export async function executeMarketTool(method,params,context,{operationId,queue,signal,config,policy=loadFeatureConfig(),rpc=marketRpc,ensure=ensureMarketService,action,sessionKey,queryReceipt=false,rewrite=rewriteMarketText,generateNews=readPreparedMarketNews,analyze=analyzeMarketRequest}={}) {
    requireMarketCommand(context);
    config??=await loadMarketConfig();const id=resolveMarket(config,context),actor=trustedMarketActor(context,policy);
    if(!authorizeFeature(policy,'sharemarket',action,context).allowed)throw new Error('permission denied');
    if(method==='account'&&params.action==='receipts') {const result=await recoverMarketDeliveries(context,{queue,config,policy,rpc,ensure,signal,rewrite});return {...result,suppressSummary:false,text:`已检查原操作回执，处理${result.recovered.length}条；未重新执行交易。`};}
    const {socket,state}=await ensure(config,id,{rpc});
    const response=await rpc(socket,{method,params,actor,operation_id:operationId},{signal});
    if(!response.ok)return response;
    return deliverMarketResult(response,context,{operationId,queue,signal,config,policy,rpc,action,sessionKey,id,actor,socket,state,rewrite,generateNews,analyze});
}
export async function deliverMarketResult(response,context,options) {
    if(!options.queue)throw new Error('market delivery queue unavailable');
    return serializeDelivery(options.queue,`sharemarket:${options.id}:${options.operationId}`,()=>deliverMarketResultNow(response,context,options));
}
async function deliverMarketResultNow(response,context,{operationId,queue,signal,config,policy,rpc=marketRpc,action,sessionKey,id,actor,socket,state,rewrite=rewriteMarketText,generateNews=readPreparedMarketNews,analyze=analyzeMarketRequest}) {
    if(!queue)throw new Error('market delivery queue unavailable');
    const privateResult=Boolean(response.private&&context.scope==='group');
    const target=privateResult?{type:'private',id:actor.senderId}:{type:context.scope,id:context.scope==='group'?actor.groupId:actor.senderId};
    if(privateResult&&config.privateQueries===false||!outboundTargetAllowed(policy,actor.accountId,target.type,target.id)) {
        // Never return the private portfolio to the model serving the group.
        if(privateResult)return {ok:true,operation_id:operationId,delivery_status:'private_unavailable',text:'当前账号无法私聊交付个人数据，请在允许的私聊入口查询；个人持仓未公开。',suppressSummary:false};
        throw new Error('market destination denied');
    }
    const dedupeKey=`sharemarket:${id}:${operationId}`;
    const existing=queue.store?.db.prepare('SELECT id,request FROM deliveries WHERE dedupe=?').get(dedupeKey);
    let delivery,visibleText;
    if(existing) {
        const previous=JSON.parse(existing.request);
        visibleText=previous.parts.filter(p=>p.type==='text').map(p=>p.text).join('\n')||'结果已按原消息交付。';
        if(previous.operationId!==operationId||previous.accountId!==actor.accountId||previous.target.type!==target.type||String(previous.target.id)!==String(target.id))throw new Error('market receipt destination conflict');
        delivery=await queue.dispatch(existing.id,{signal});
    } else {
    const parts=[];
    const inferredHint=marketReadHint(context.marketReadResolution,response.scope?.label??response.data?.name);
    const analysis=response.analysis?await analyze(response.question,response.data,context,{signal}):null;
    const baseDraft=analysis?.text??String(response.text??'');
    const draft=inferredHint?'「'+inferredHint.replace(/[「」]/gu,'')+'」\n'+baseDraft:baseDraft;
    const rendered=response.news?await generateNews(response.data,context,{signal,config,marketId:id,scope:response.scope?.label??'全市场'}):draft?await rewrite(draft,context,{signal,policy,...(response.analysis?{budgetMs:40000,attemptMs:15000}:{})}):null;
    if(response.news&&inferredHint)rendered.nodes[0].text=inferredHint+'\n'+rendered.nodes[0].text;
    if(response.news)parts.push({type:'forward',nodes:rendered.nodes});
    else if(rendered)for(const text of splitMarketText(rendered.text))parts.push({type:'text',text});
    for(const artifact of await marketArtifacts(response,state))parts.push({type:'image',path:artifact});
    visibleText=rendered?.text??(response.news?'公开市场新闻已通过合并消息交付。':baseDraft);
    delivery=await queue.enqueue({accountId:actor.accountId,target,feature:'sharemarket',action,context,operationId,workspaceAgentId:context.workspaceAgentId,sessionKey:sessionKey??context.sessionKey,dedupeKey,parts,...(response.news?{marketNews:true}:{}),persona:rendered?{name:rendered.personaName,workspaceAgentId:rendered.workspaceAgentId,status:rendered.status,reason:rendered.reason,model:rendered.model}:undefined},{signal});
    }
    if(delivery.state==='accepted')await rpc(socket,{method:'ack',actor,id:operationId,receipt:{deliveryId:delivery.id,...delivery.receipt}},{timeoutMs:10000}).catch(()=>{});
    return {ok:true,operation_id:operationId,market_id:id,delivery_status:delivery.state,deliveryId:delivery.id,delivered:delivery.state==='accepted',private:privateResult,suppressSummary:true,
        text:privateResult?'个人结果已私聊交付。':visibleText,
        replyInstruction:delivery.state==='accepted'?'结果已发送，结束本轮，不要重复总结或再次调用下单。':'交易结果已保存；投递尚未确认，不要重下单。原操作编号可用于查收原结果。'};
}

// Recover persisted receipts only; this path never runs a trade or reward again.
export async function recoverMarketDeliveries(context,{queue,config,policy=loadFeatureConfig(),rpc=marketRpc,ensure=ensureMarketService,signal,rewrite=rewriteMarketText}={}) {
    config??=await loadMarketConfig();const id=resolveMarket(config,context),actor=trustedMarketActor(context,policy);
    const {socket,state}=await ensure(config,id,{rpc});
    const pending=await rpc(socket,{method:'outbox',actor},{signal});const recovered=[];
    for(const row of pending.items??[]) {
        const event=JSON.parse(row.payload);
        const action=event.method==='query'?'read':event.method==='play'?(['ipo','subscribe','issue','margin_status','borrow_cash','repay_cash','borrow_stock','cover'].includes(event.params?.action)?'advanced':'play'):event.method;
        if(!authorizeFeature(policy,'sharemarket',action,context).allowed)continue;
        const response=await rpc(socket,{method:'result',actor,id:row.id},{signal});
        recovered.push(await deliverMarketResult(response,context,{operationId:row.id,queue,signal,config,policy,rpc,action,id,actor,socket,state,rewrite}));
    }
    return {ok:true,recovered};
}

// Cron callers receive a read-only public snapshot capability, never a player ID.
export async function executeMarketAnnouncement(jobId,slot,{queue,config,policy=loadFeatureConfig(),registry=loadServiceRegistry(),rpc=marketRpc,ensure=ensureMarketService,signal,rewrite=rewriteMarketText}={}) {
    config??=await loadMarketConfig();const route=config.announcements?.[jobId],binding=policy.automationBindings[jobId],subject=registry.jobs?.[jobId];
    if(!route?.enabled||!subject||subject.feature!=='sharemarket'||subject.accountId!==route.accountId||!subject.actions?.includes('read')||!binding?.enabled||binding.feature!=='sharemarket'||!binding.deliveryGroupIds?.includes(route.groupId)||!automationFeatureEnabled(policy,'sharemarket','read',route.accountId)||!policy.features.sharemarket.groupIds.includes(route.groupId)||!outboundTargetAllowed(policy,route.accountId,'group',route.groupId))throw new Error('market announcement grant denied');
    if(!['overview','news','rank'].includes(route.kind)||!config.markets[route.marketId]?.enabled||config.groups[route.groupId]!==route.marketId)throw new Error('market announcement binding denied');
    if(typeof slot!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/u.test(slot))throw new Error('invalid announcement slot');
    const actor={accountId:route.accountId,scope:'group',groupId:route.groupId,identity:'service',serviceJobId:jobId};
    const id=route.marketId,operationId=`announcement:${jobId}:${slot}`,{socket,state}=await ensure(config,id,{rpc});
    const response=await rpc(socket,{method:'broadcast',actor,operation_id:operationId,params:{action:route.kind}},{signal});
    if(!response.ok)return response;
    const delivery=await serializeDelivery(queue,`sharemarket:${id}:${operationId}`,async()=>{
        const dedupeKey=`sharemarket:${id}:${operationId}`;
        const existing=queue.store?.db.prepare('SELECT id,request FROM deliveries WHERE dedupe=?').get(dedupeKey);
        if(existing){
            const previous=JSON.parse(existing.request);
            if(previous.originJobId!==jobId||previous.accountId!==route.accountId||previous.target.type!=='group'||String(previous.target.id)!==route.groupId)throw new Error('market announcement receipt destination conflict');
            return queue.dispatch(existing.id,{signal});
        }
        const rendered=await rewrite(response.text,{accountId:route.accountId,scope:'group',groupId:route.groupId,actorType:'service',workspaceAgentId:subject.agentId},{signal,policy});
        const parts=splitMarketText(rendered.text).map(text=>({type:'text',text}));
        for(const artifact of await marketArtifacts(response,state))parts.push({type:'image',path:artifact});
        return queue.enqueue({accountId:route.accountId,target:{type:'group',id:route.groupId},feature:'sharemarket',action:'read',originJobId:jobId,workspaceAgentId:rendered.workspaceAgentId??subject.agentId,operationId,dedupeKey,
            persona:{name:rendered.personaName,workspaceAgentId:rendered.workspaceAgentId,status:rendered.status,reason:rendered.reason,model:rendered.model},parts},{signal});
    });
    if(delivery.state==='accepted')await rpc(socket,{method:'ack',actor,id:operationId,receipt:delivery.receipt});
    return {ok:true,state:delivery.state};
}

/** Validate the complete image set before enqueuing; never silently send only its first image. */
export async function marketArtifacts(response,state){
    const paths=response.artifacts??(response.artifact?[response.artifact]:[]);
    if(!Array.isArray(paths)||paths.length>40||new Set(paths).size!==paths.length)throw new Error('invalid market artifact list');
    const allowed=resolve(state,'artifacts')+sep,result=[];
    for(const path of paths){
        if(typeof path!=='string')throw new Error('invalid market artifact');
        const artifact=await realpath(path);
        if(!artifact.startsWith(allowed)||!artifact.endsWith('.png'))throw new Error('invalid market artifact');
        result.push(artifact);
    }
    return result;
}
