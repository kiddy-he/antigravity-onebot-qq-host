#!/usr/bin/env node
import {planNewsBinding} from '../src/src/features/sharemarket-news.js';
import {loadServiceRegistry} from '../src/src/access/services.js';
/** Local operator tooling. No QQ messages are sent by this command. */
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadMarketConfig,ensureMarketService,marketRpc} from '../src/src/features/sharemarket.js';
import {loadFeatureConfig} from '../src/src/feature-policy.js';
import {onebotPath} from '../src/src/paths.js';

export function planBinding(policy,config,{groupId,marketId,accountId='default',remove=false}) {
    groupId=String(groupId);
    if(!/^[1-9][0-9]{4,19}$/u.test(groupId)||!policy.groups[groupId]?.enabled||!policy.accounts[accountId]?.groupIds.includes(groupId))throw new Error('只能绑定当前已开放给该角色的群聊；此脚本不会新增聊天入口。');
    if(!config.markets[marketId]?.enabled)throw new Error('市场不存在或未启用。');
    if(!policy.features.sharemarket?.enabled||!policy.features.sharemarket.accountIds.includes(accountId))throw new Error('该角色的股市功能未启用。');
    const nextPolicy=structuredClone(policy),nextConfig=structuredClone(config);
    if(remove) {delete nextConfig.groups[groupId];nextPolicy.features.sharemarket.groupIds=nextPolicy.features.sharemarket.groupIds.filter(id=>id!==groupId);}
    else {nextConfig.groups[groupId]=marketId;nextPolicy.features.sharemarket.groupIds=[...new Set([...nextPolicy.features.sharemarket.groupIds,groupId])];}
    return {policy:nextPolicy,config:nextConfig};
}
export async function restartMarket(config,id,{rpc=marketRpc,ensure=ensureMarketService}={}) {
    if(!config.markets[id])throw new Error('unknown market');
    const state=join(resolve(config.stateRoot??onebotPath('state/sharemarket')),id),socket=join(state,'runtime.sock');
    let health;
    try{health=await rpc(socket,{method:'health'},{timeoutMs:1500});}catch(error){if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;return ensure(config,id,{rpc});}
    if(!Number.isInteger(health.pid)||health.market_id!==id)throw new Error('市场进程身份无法验证。');
    const command=(await readFile(`/proc/${health.pid}/cmdline`,'utf8')).split('\0');
    if(!command.includes('astrbot_plugin_sharemarket.runtime')||command[command.indexOf('--state-dir')+1]!==state)throw new Error('拒绝停止身份不符的进程。');
    process.kill(health.pid,'SIGTERM');
    for(let attempt=0;attempt<400;attempt++) {
        try{process.kill(health.pid,0);}catch(error){if(error.code==='ESRCH')return ensure(config,id,{rpc});throw error;}
        // A zombie has released its DB/socket lock and can safely be replaced.
        try{if((await readFile(`/proc/${health.pid}/stat`,'utf8')).split(') ')[1]?.startsWith('Z'))return ensure(config,id,{rpc});}catch(error){if(error.code==='ENOENT')return ensure(config,id,{rpc});throw error;}
        await new Promise(done=>setTimeout(done,100));
    }
    throw new Error('市场仍在完成原请求，未强制停止；请稍后重试。');
}
async function main(argv) {
    const [command,...rest]=argv;
    const configPath=onebotPath('onebot-sharemarket.json'),policyPath=onebotPath('onebot-features.json');
    const config=await loadMarketConfig(configPath);
    if(command==='status') {
        for(const id of Object.keys(config.markets)) {
            const socket=join(resolve(config.stateRoot??onebotPath('state/sharemarket')),id,'runtime.sock');
            try{console.log(JSON.stringify(await marketRpc(socket,{method:'health'},{timeoutMs:1500})));}catch{console.log(JSON.stringify({market_id:id,running:false}));}
        }
    } else if(command==='start'||command==='restart') {
        const id=rest[0];if(!config.markets[id]?.enabled)throw new Error('unknown enabled market');
        await (command==='restart'?restartMarket(config,id):ensureMarketService(config,id));console.log(`${id}: ready`);
    } else if(command==='bind'||command==='unbind') {
        const [groupId,marketId,accountId='default']=rest.filter(x=>x!=='--apply');
        const basic=planBinding(loadFeatureConfig(),config,{groupId,marketId,accountId,remove:command==='unbind'});
        const plan=planNewsBinding(basic.policy,basic.config,loadServiceRegistry(),{groupId,marketId,accountId,remove:command==='unbind'});
        const registryPath=onebotPath('onebot-services.json');
        if(!rest.includes('--apply')){console.log(JSON.stringify({dryRun:true,groupId,marketId,accountId,action:command},null,2));return;}
        const backup=onebotPath(`state/sharemarket/config-backups/${Date.now()}`);await mkdir(backup,{recursive:true,mode:0o700});
        const originals=new Map();
        for(const path of [configPath,policyPath,registryPath]){const bytes=await readFile(path);originals.set(path,bytes);await writeFile(join(backup,path===configPath?'markets.json':path===policyPath?'policy.json':'services.json'),bytes,{mode:0o600});}
        try{
            for(const [path,value] of [[configPath,plan.config],[policyPath,plan.policy],[registryPath,plan.registry]]){await writeFile(path+'.sharemarket.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.sharemarket.tmp',path);}
            await loadMarketConfig();loadFeatureConfig();
        }catch(error){for(const [path,bytes] of originals){await writeFile(path+'.sharemarket.tmp',bytes,{mode:0o600});await rename(path+'.sharemarket.tmp',path);}throw error;}
        console.log('群绑定和独立新闻播报授权已保存；现有聊天入口保持原配置。');
    } else throw new Error('Usage: sharemarket-admin.mjs status | start MARKET | restart MARKET | bind GROUP MARKET [ACCOUNT] [--apply] | unbind GROUP MARKET [ACCOUNT] [--apply]');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
