#!/usr/bin/env node
// Independent supervised worker: no gateway restart and no conversation slots.
import {loadMarketConfig} from '../src/src/features/sharemarket.js';
import {pollMarketNewsRoute,newsSettings} from '../src/src/features/sharemarket-news.js';
import {preproduceMarketNews} from '../src/src/features/sharemarket-news-producer.js';
import {deliveryQueue} from '../src/src/delivery/queue.js';
import {setTimeout as delay} from 'node:timers/promises';
let stopping=false;const stop=new AbortController();
process.once('SIGTERM',()=>{stopping=true;stop.abort();});process.once('SIGINT',()=>{stopping=true;stop.abort();});
const queue=deliveryQueue();
let preparing=null;
function schedulePreparation(config){
    if(preparing||stopping||!config.enabled)return;
    preparing=preproduceMarketNews(config,{signal:stop.signal})
        .then(results=>{for(const result of results)if(result.count)console.log(JSON.stringify({event:'market_news_prepared',...result}));})
        .catch(()=>{if(!stopping)console.error(JSON.stringify({event:'market_news_preparation_failed'}));})
        .finally(()=>{preparing=null;});
}
while(!stopping){
    let seconds=3;
    try{
        const config=await loadMarketConfig();seconds=newsSettings(config.news).pollSeconds;
        schedulePreparation(config);
        if(config.enabled&&config.news?.enabled){
            const jobs=Object.keys(config.news.routes??{}).filter(id=>config.news.routes[id].enabled);
            // Delivery reads pre-generated articles; it never waits for a model call.
            for(let offset=0;offset<jobs.length&&!stopping;offset+=2){
                const result=await Promise.allSettled(jobs.slice(offset,offset+2).map(jobId=>pollMarketNewsRoute(jobId,{queue,config,signal:AbortSignal.any([stop.signal,AbortSignal.timeout(15000)])})));
                for(const item of result)if(item.status==='rejected'&&!stopping)console.error(JSON.stringify({event:'market_news_cycle_failed',error:String(item.reason?.message??'unknown').slice(0,180)}));
            }
        }
    }catch(error){if(!stopping)console.error(JSON.stringify({event:'market_news_worker_failed',error:String(error.message).slice(0,180)}));}
    if(!stopping)await delay(seconds*1000,undefined,{signal:stop.signal}).catch(()=>{});
}

await preparing;
