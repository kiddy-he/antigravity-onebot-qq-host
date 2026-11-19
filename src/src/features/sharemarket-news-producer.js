/** Independent producer: render every public event before anyone queries it. */
import {normalizeMarketCatalogue} from './sharemarket-symbols.js';
import {readFile} from 'node:fs/promises';
import {onebotPath} from '../paths.js';
import {NewsPublicationStore,publicationPath,prepareMarketNews} from './sharemarket-news-cache.js';
import {loadFeatureConfig} from '../feature-policy.js';
import {marketRpc,ensureMarketService} from './sharemarket.js';
export async function preproduceMarketNews(config,{policy=loadFeatureConfig(),roleConfig,rpc=marketRpc,ensure=ensureMarketService,store,generate,signal}={}){
    if(!config.enabled||!policy.features.sharemarket?.enabled)return [];
    roleConfig??=JSON.parse(await readFile(onebotPath('onebot-role-routing.json'),'utf8'));
    const accounts=[...new Set(Object.values(roleConfig.roles??{}).filter(role=>role.enabled!==false&&policy.features.sharemarket.accountIds.includes(role.accountId)).map(role=>role.accountId))];
    const own=!store;store??=new NewsPublicationStore(publicationPath(config));const results=[];
    try{
        for(const [marketId,market] of Object.entries(config.markets)){
            if(!market.enabled)continue;
            const {socket}=await ensure(config,marketId,{rpc});
            const symbols=await rpc(socket,{method:'catalogue'},{signal,timeoutMs:5000});
            if(!symbols.ok||symbols.market_id!==marketId)throw new Error('market public catalogue unavailable');
            const catalogue=normalizeMarketCatalogue(symbols);
            for(const accountId of accounts){
                signal?.throwIfAborted();let after=store.cursor(marketId,accountId);
                // Ingestion is durable separately from model completion; crashes do not lose events.
                for(let page=0;page<3;page++){
                    const feed=await rpc(socket,{method:'news_feed',after,limit:200},{signal});
                    if(!feed.ok)throw new Error('market public feed unavailable');
                    store.ingest(marketId,accountId,feed.items);if(!feed.items.length)break;
                    after=feed.items.at(-1).seq;if(feed.items.length<200)break;
                }
                // Two claimed batches at most; disjoint leases survive restarts and prevent duplicate work.
                const prepared=await Promise.allSettled(Array.from({length:2},()=>prepareMarketNews(marketId,{accountId,scope:'private',actorType:'service'},{store,items:[],generate,signal,catalogue})));
                for(const item of prepared){
                    if(item.status==='fulfilled')results.push({marketId,accountId,...item.value});
                    else results.push({marketId,accountId,state:'retry_pending',count:0});
                }
                signal?.throwIfAborted();
            }
        }
        return results;
    }finally{if(own)store.close();}
}
