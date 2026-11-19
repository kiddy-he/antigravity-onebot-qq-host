import {selectPublicNews,newsVisibleText,sanitizeMarketCopy,NEWS_STAGES} from './sharemarket-news-content.js';
import {readPreparedMarketNews} from './sharemarket-news-cache.js';
import {recordVisibleMessage} from '../destination-context.js';
/** Public market news worker. No conversation agent runs or chat-turn locks. */
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {onebotPath} from '../paths.js';
import {loadFeatureConfig,automationFeatureEnabled,outboundTargetAllowed} from '../feature-policy.js';
import {loadServiceRegistry} from '../access/services.js';
import {loadMarketConfig,marketRpc,ensureMarketService} from './sharemarket.js';

export const NEWS_DEFAULTS=Object.freeze({pollSeconds:3,normalIntervalSeconds:300,urgentIntervalSeconds:60,quietSeconds:45,maxDeferralSeconds:180,maxPerHour:8,maxItems:4,maxAgeSeconds:1800});
const bounds={pollSeconds:[1,60],normalIntervalSeconds:[60,3600],urgentIntervalSeconds:[15,600],quietSeconds:[0,300],maxDeferralSeconds:[30,1800],maxPerHour:[1,30],maxItems:[1,8],maxAgeSeconds:[300,86400]};
export function newsSettings(news={}){
    const value={...NEWS_DEFAULTS,...news.settings};
    for(const [name,[min,max]] of Object.entries(bounds))if(!Number.isInteger(value[name])||value[name]<min||value[name]>max)throw new Error('invalid market news setting: '+name);
    if(Object.keys(value).some(x=>!Object.hasOwn(bounds,x)))throw new Error('unknown market news setting');
    return value;
}
export function newsJobId(groupId,accountId,marketId){
    const hex=createHash('sha256').update(`market-news:${groupId}:${accountId}:${marketId}`).digest('hex');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function planNewsBinding(policy,config,registry,{groupId,accountId='default',marketId,remove=false}){
    policy=structuredClone(policy);config=structuredClone(config);registry=structuredClone(registry);
    config.news??={enabled:true,settings:{...NEWS_DEFAULTS},routes:{}};config.news.routes??={};registry.version??=1;registry.jobs??={};policy.automationBindings??={};
    for(const [id,route] of Object.entries(config.news.routes))if(route.groupId===groupId){delete config.news.routes[id];delete registry.jobs[id];delete policy.automationBindings[id];}
    if(!remove){
        const id=newsJobId(groupId,accountId,marketId);
        config.news.routes[id]={enabled:true,groupId,accountId,marketId};
        registry.jobs[id]={kind:'command',feature:'sharemarket',accountId,actions:['read'],marketId,groupId,type:'market-news'};
        policy.automationBindings[id]={enabled:true,feature:'sharemarket',name:'sharemarket-news',deliveryGroupIds:[groupId]};
    }
    return {policy,config,registry};
}
export function authorizeNewsRoute(jobId,config,policy,registry){
    const route=config.news?.routes?.[jobId],job=registry.jobs?.[jobId],binding=policy.automationBindings?.[jobId];
    if(!config.enabled||!config.news?.enabled||!route?.enabled||config.groups?.[route.groupId]!==route.marketId||!config.markets?.[route.marketId]?.enabled
       ||job?.type!=='market-news'||job.feature!=='sharemarket'||job.kind!=='command'||job.accountId!==route.accountId||job.marketId!==route.marketId||job.groupId!==route.groupId||!job.actions?.includes('read')
       ||!binding?.enabled||binding.feature!=='sharemarket'||!binding.deliveryGroupIds?.includes(route.groupId)
       ||!automationFeatureEnabled(policy,'sharemarket','read',route.accountId)||!policy.features.sharemarket.groupIds.includes(route.groupId)||!outboundTargetAllowed(policy,route.accountId,'group',route.groupId))throw new Error('market news grant denied');
    newsSettings(config.news);return route;
}
export function lastGroupActivity(groupId,{path=onebotPath('state','onebot-destination-context.sqlite')}={}){
    if(!existsSync(path))return 0;
    let db;try{db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA busy_timeout=100');return Number(db.prepare("SELECT MAX(at) AS at FROM visible_messages WHERE destination=? AND source='inbound'").get(`group:${groupId}:public:normal`)?.at??0);}
    catch{return Date.now();}finally{db?.close();}
}
export function newsStateStore(store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS sharemarket_news_routes(id TEXT PRIMARY KEY,cursor INTEGER NOT NULL,pending TEXT,last_sent INTEGER NOT NULL,history TEXT NOT NULL,deferred INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sharemarket_news_receipts(dedupe TEXT PRIMARY KEY,delivery_id TEXT,state TEXT NOT NULL,at INTEGER NOT NULL);`);
    return {
        get(id){const row=store.db.prepare('SELECT * FROM sharemarket_news_routes WHERE id=?').get(id);return row?{...row,pending:row.pending?JSON.parse(row.pending):null,history:JSON.parse(row.history)}:null;},
        save(id,row){store.db.prepare('INSERT INTO sharemarket_news_routes VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,pending=excluded.pending,last_sent=excluded.last_sent,history=excluded.history,deferred=excluded.deferred').run(id,row.cursor,row.pending?JSON.stringify(row.pending):null,row.last_sent,JSON.stringify(row.history),row.deferred);},
        receipt(dedupe,delivery){store.db.prepare('INSERT OR REPLACE INTO sharemarket_news_receipts VALUES(?,?,?,?)').run(dedupe,delivery.id??null,delivery.state,Date.now());},
    };
}
const stages=NEWS_STAGES;
export function buildNewsDigest(items,maxItems=4){
    const chosen=selectPublicNews(items,maxItems);
    const lines=chosen.map(r=>{
        const facts=Object.entries(r.facts??{}).map(([k,v])=>`${k}：${v}`).join('；');
        const headline=sanitizeMarketCopy(String(r.headline).replace(/[「」\r\n]/gu,' '));
        return `「#${r.seq} · 第${r.day}日 · ${stages[r.stage]??'公开更新'} · ${r.event_id}：${headline}${facts?'；'+facts:''}」`;
    });
    const omitted=Math.max(0,items.length-chosen.length);
    return `【市场快讯】\n${lines.join('\n')}${omitted?`\n本批另有${omitted}条进展，已合并或收录于新闻列表。`:''}\n可用 /fx 新闻 查看近期公告，/fx 事件 加事件编号查看已公开进展。`;
}
export function newsDecision(items,state,settings,{now=Date.now(),lastActivity=0}={}){
    const fresh=items.filter(x=>x.published_at>=now-settings.maxAgeSeconds*1000);
    if(!fresh.length)return {send:false,stale:true};
    const urgent=fresh.some(x=>x.severity>=3),interval=(urgent?settings.urgentIntervalSeconds:settings.normalIntervalSeconds)*1000;
    if(state.history.filter(x=>x>now-3600000).length>=settings.maxPerHour)return {send:false,reason:'hourly_budget'};
    if(now-state.last_sent<interval)return {send:false,reason:'cooldown'};
    const waiting=now-(state.deferred||now);
    if(now-lastActivity<settings.quietSeconds*1000&&waiting<settings.maxDeferralSeconds*1000)return {send:false,reason:'chat_active'};
    return {send:true,urgent,fresh};
}

export async function pollMarketNewsRoute(jobId,{queue,config,policy=loadFeatureConfig(),registry=loadServiceRegistry(),rpc=marketRpc,ensure=ensureMarketService,generate=readPreparedMarketNews,now=Date.now(),activity=lastGroupActivity,stateStore,record=recordVisibleMessage,signal}={}){
    config??=await loadMarketConfig();const route=authorizeNewsRoute(jobId,config,policy,registry),settings=newsSettings(config.news);
    const store=stateStore??newsStateStore(queue.store),id=`${jobId}:${route.marketId}`,{socket}=await ensure(config,route.marketId,{rpc});
    let state=store.get(id);
    if(!state){const feed=await rpc(socket,{method:'news_feed',after:0,limit:1},{signal});state={cursor:feed.latest_seq,pending:null,last_sent:0,history:[],deferred:0};store.save(id,state);return {ok:true,state:'initialized'};}
    if(!state.pending){
        let items=[],after=state.cursor;
        for(let page=0;page<3;page++){
            const feed=await rpc(socket,{method:'news_feed',after,limit:200},{signal});
            if(!feed.ok)throw new Error('market public feed unavailable');
            if(!feed.items.length)break;items.push(...feed.items);after=feed.items.at(-1).seq;if(feed.items.length<200)break;
        }
        if(!items.length)return {ok:true,state:'idle'};
        state.deferred||=now;
        const decision=newsDecision(items,state,settings,{now,lastActivity:await activity(route.groupId)});
        if(!decision.send){if(decision.stale){state.cursor=after;state.deferred=0;}store.save(id,state);return {ok:true,state:decision.stale?'stale_skipped':decision.reason};}
        state.pending={to:after,items:selectPublicNews(decision.fresh,settings.maxItems),draft:buildNewsDigest(decision.fresh,settings.maxItems),dedupe:`sharemarket-news:${id}:${state.cursor}:${after}`,created:now};
        // Reserve immutable intent BEFORE model invocation or enqueue. A crash
        // after transport acceptance cannot create a new batch identity.
        store.save(id,state);
    }
    signal?.throwIfAborted();const pending=state.pending;
    if(now>pending.created+settings.maxAgeSeconds*1000){state.cursor=pending.to;state.pending=null;state.deferred=0;store.save(id,state);return {ok:true,state:'expired',to:state.cursor};}
    const existing=queue.store?.db.prepare('SELECT id,request FROM deliveries WHERE dedupe=?').get(pending.dedupe);
    let delivery,deliveredRequest;
    if(existing){
        const request=JSON.parse(existing.request);deliveredRequest=request;
        if(request.originJobId!==jobId||request.accountId!==route.accountId||request.target.type!=='group'||String(request.target.id)!==route.groupId)throw new Error('news receipt destination conflict');
        delivery=await queue.dispatch(existing.id,{signal});
    }else{
        const context={accountId:route.accountId,scope:'group',groupId:route.groupId,actorType:'service'};
        // Old pending batches can finish as labelled public facts without inventing a new identity.
        if(!pending.publication){
            const publication=pending.items?await generate(pending.items,context,{signal,config,marketId:route.marketId,maxItems:settings.maxItems}):
                {nodes:[{title:'市场快讯',text:pending.draft}],status:'legacy-facts'};
            if(publication.pending)return {ok:true,state:'news_preparing'};
            pending.publication=publication;
        }
        store.save(id,state);
        const text=pending.publication;
        // Recheck hot-loaded policy inside DeliveryQueue immediately before send.
        deliveredRequest={accountId:route.accountId,target:{type:'group',id:route.groupId},feature:'sharemarket',action:'read',originJobId:jobId,
            marketNewsRoute:route.marketId,marketNews:true,workspaceAgentId:text.workspaceAgentId,operationId:pending.dedupe,dedupeKey:pending.dedupe,expiresAt:pending.created+settings.maxAgeSeconds*1000,
            persona:{name:text.personaName,workspaceAgentId:text.workspaceAgentId,status:text.status,model:text.model},parts:[{type:'forward',nodes:text.nodes}]};
        delivery=await queue.enqueue(deliveredRequest,{signal});
    }
    store.receipt(pending.dedupe,delivery);
    if(delivery.state==='accepted'&&deliveredRequest)record({type:'group',id:route.groupId,accountId:route.accountId},{messageId:delivery.id,text:deliveredRequest.parts[0].type==='forward'?newsVisibleText(deliveredRequest.parts[0].nodes):deliveredRequest.parts[0].text,senderName:deliveredRequest.persona?.name??'市场',source:'delivered',delivered:true});
    if(['accepted','native_pending','uncertain','revoked','expired','suppressed','cancelled'].includes(delivery.state)){
        // Native pending/uncertain transport belongs to the durable core. Do not
        // re-create it or block all future public information behind a receipt.
        state.cursor=pending.to;state.pending=null;state.deferred=0;
        if(!['revoked','expired','suppressed','cancelled'].includes(delivery.state)){state.last_sent=now;state.history=state.history.filter(x=>x>now-3600000).concat(now);}
        store.save(id,state);
    }
    return {ok:true,state:delivery.state,to:state.cursor};
}
