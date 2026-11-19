import {mkdir, mkdtemp, readFile, writeFile, rename, rm, lstat} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {FEATURE_ACTIONS, configuredAllowFrom, configuredRoleGroups, validateFeatureConfig} from '../src/src/feature-policy.js';
import {validateAiConfig} from '../src/src/ai/router.js';

const [settingsPath, destination] = process.argv.slice(2);
if (!settingsPath || !destination) throw Error('Usage: npm run init -- accounts.local.json NEW_CONFIG_DIRECTORY');
const spec = JSON.parse(await readFile(settingsPath, 'utf8'));
const root = resolve(destination);
if (await lstat(root).catch(e => { if (e.code !== 'ENOENT') throw e; })) throw Error('Choose a new configuration directory');
if (!Number.isInteger(spec.gatewayPort) || spec.gatewayPort < 1 || spec.gatewayPort > 65535) throw Error('Invalid gateway port');
for (const model of [spec.cliModel, spec.geminiModel]) {
    if (typeof model !== 'string' || !model.trim() || model.startsWith('YOUR_') || /[\s/]/u.test(model)) throw Error('Set both model IDs');
}
const qq = id => typeof id === 'string' && /^[1-9][0-9]{4,19}$/u.test(id);
if (!Array.isArray(spec.accounts) || !spec.accounts.length) throw Error('Configure one or two accounts');
const ids = spec.accounts.map(a => a.id);
if (!ids.includes('default') || ids.some(id => !['default','yuexia'].includes(id)) || new Set(ids).size !== ids.length) throw Error('Account IDs are default and optionally yuexia');
if (new Set(spec.accounts.map(a => a.selfId)).size !== ids.length) throw Error('Each account needs a distinct QQ identity');
for (const account of spec.accounts) {
    if (!qq(account.selfId) || !account.name || !/^[A-Z][A-Z0-9_]*$/u.test(account.tokenEnv)) throw Error('Invalid account or token environment name');
    for (const key of ['privateAdminIds','groupIds']) if (!Array.isArray(account[key]) || !account[key].every(qq)) throw Error('QQ identities must be decimal strings');
    for (const [key,protocols] of [['wsUrl',['ws:','wss:']],['httpUrl',['http:','https:']]]) {
        const url = new URL(account[key]);
        if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Use a token-free OneBot endpoint');
    }
}
const readers = ['approval.reviewer.primary','approval.reviewer.secondary','approval.reviewer.tertiary'];
const chatTasks = ['chat.reply','chat.reply.rewrite','chat.peer.followup','chat.peer.select','bilibili.live.copy'];
const httpTasks = ['market.intent.classify','inbound.intent','chat.text.review','chat.content.fallback','chat.error.fallback','media.summary','media.summary.review',...readers];
const ai = {
    schemaVersion:1, revision:'public-starter', enabled:true,
    providers:{
        'antigravity-cli':{adapter:'antigravity-cli',registryId:'antigravity-cli'},
        'gemini-official':{adapter:'gemini-native',registryId:'gemini-official',baseUrl:'https://generativelanguage.googleapis.com/v1beta',
            credential:{source:'env',name:'GEMINI_API_KEY'}}
    },
    deployments:{
        chat:{provider:'antigravity-cli',model:spec.cliModel,capabilities:['text','vision','json','nativeSearch']},
        official:{provider:'gemini-official',model:spec.geminiModel,capabilities:['text','vision','json']}
    },
    routes:Object.fromEntries(['chat','official'].map(id=>[id,{steps:[{deployment:id,timeoutMs:120000}],budgetMs:125000,fallbackOn:[]}])),
    tasks:Object.fromEntries([...chatTasks,...httpTasks].map(id=>[id,{enabled:true,route:chatTasks.includes(id)?'chat':'official',requires:['text']}])),
    bindings:{quotaModels:[],quotaFamilies:{},rewriteTasks:{},approval:{reviewers:readers,quorum:2,isolatedReviewers:readers,isolatedQuorum:2}},
    profiles:{},workflows:{},extensions:{}
};
if (spec.decisionModel) {
    if (typeof spec.decisionModel !== 'string' || !/^[a-zA-Z0-9._-]+$/u.test(spec.decisionModel)) throw Error('Invalid Decisions model');
    ai.providers.decisions = {...ai.providers['gemini-official'], adapter:'gemini-decisions', registryId:'decisions'};
    ai.deployments.decisions = {provider:'decisions',model:spec.decisionModel,capabilities:['json']};
    ai.routes.decisions = {steps:[{deployment:'decisions',timeoutMs:30000}],budgetMs:30000,fallbackOn:[]};
    ai.tasks['inbound.intent.decision'] = {enabled:true,route:'decisions',requires:['json']};
}
validateAiConfig(ai);
const roles = {}, accounts = {}, groups = {}, agents = {}, routes = {}, entries = {}, channel = {accounts:{}};
const admins = [...new Set(spec.accounts.flatMap(a=>a.privateAdminIds))];
for (const account of spec.accounts) {
    const first = account.id === 'default', role = first ? 'elysia' : 'yuexia', base = first ? 'main' : 'onebot-yuexia';
    roles[role] = {enabled:true,agentId:base,accountId:account.id,displayName:account.name,names:[account.name],selfIds:[account.selfId],peerSoulPath:'',allowNsfw:false};
    accounts[account.id] = {privateAdminIds:account.privateAdminIds,groupIds:account.groupIds,allowPrivateGuests:false};
    for (const group of account.groupIds) {
        groups[group] ??= {enabled:true,roles:[],requireMention:true};
        groups[group].roles.push(role);
    }
    const scopes = [['private','operator'],...account.groupIds.map(id=>['group',id]),['automation','public']];
    for (const [scope,conversationId] of scopes) {
        const key = [scope,conversationId,base,'normal'].join(':');
        routes[key] = {};
        for (const purpose of ['main','review','peer','rewrite','fallback','vision']) {
            const agentId = scope==='private' && purpose==='main' ? base : [base,scope,conversationId,purpose].join('-');
            const workspace = join(root,'workspaces',agentId);
            routes[key][purpose] = agentId;
            agents[agentId] = {baseAgentId:base,roleAgentId:base,scope,conversationId,purpose,mode:'normal',workspace};
            entries[agentId] = {workspace};
        }
    }
}
for (const r of ['elysia','yuexia']) if (!roles[r]) roles[r] = {enabled:false};
const policy = {
    version:1,identities:{adminIds:admins},groups,accounts,automationBindings:{},
    profiles:{chat:{identities:['admin','member'],scopes:['private','group'],singleRoleInGroup:false}},
    features:Object.fromEntries(Object.entries(FEATURE_ACTIONS).map(([id,actions])=>[id,{
        name:id,enabled:id==='conversation',implemented:true,groupIds:Object.keys(groups),accountIds:ids,
        actions:Object.fromEntries(actions.map(a=>[a,{enabled:id==='conversation'&&['chat','quote','reset'].includes(a),profile:'chat'}]))
    }]))
};
validateFeatureConfig(policy);
for (const a of spec.accounts) {
    const cfg = {name:a.name,enabled:true,wsUrl:a.wsUrl,httpUrl:a.httpUrl,accessTokenEnv:a.tokenEnv,allowFrom:configuredAllowFrom(a.id,policy)};
    if (a.id==='default') Object.assign(channel,cfg); else channel.accounts[a.id]=cfg;
}
const files = {
    'onebot-ai.json':ai,'onebot-features.json':policy,'onebot-workspaces.json':{version:1,agents,routes},
    'onebot-role-routing.json':{roles,groups:configuredRoleGroups(policy),adminIds:admins},
    'onebot-services.json':{version:1,jobs:{}},
    'onebot-delivery.json':{version:1,minAccountGapMs:100,minTargetGapMs:100,maxInFlight:1,artifactRetentionDays:7,defaultTtlMs:300000},
    'onebot-xhs.json':{version:1,enabled:false},'onebot-bilibili.json':{version:1,enabled:false,routes:[]},'onebot-x.json':{version:1,enabled:false,publicLinks:false},
    'openclaw.json':{gateway:{port:spec.gatewayPort},channels:{onebot:channel},cron:{enabled:true},tools:{deny:['*']},
        agents:{defaults:{workspace:join(root,'workspaces'),timeoutSeconds:180},entries},models:{providers:{}}}
};
await mkdir(dirname(root),{recursive:true,mode:0o700});
const stage = await mkdtemp(join(dirname(root),'.onebot-init-'));
try {
    const write = (name,value) => writeFile(join(stage,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
    for (const [name,value] of Object.entries(files)) await write(name,value);
    // The catalog reads model bindings at module load time.
    process.env.ONEBOT_AI_CONFIG=join(stage,'onebot-ai.json');
    const {BUSINESS_TOOLS} = await import('../src/src/features/catalog.js');
    await write('onebot-executors.json',{version:1,tools:Object.fromEntries(Object.entries(BUSINESS_TOOLS).map(([id,s])=>[id,{enabled:false,timeoutMs:s.timeoutMs,maxConcurrent:1}]))});
    for (const id of Object.keys(agents)) {
        const dir=join(stage,'workspaces',id);
        await mkdir(dir,{recursive:true,mode:0o700});
        await writeFile(join(dir,'SOUL.md'),'你是 QQ 对话助手。直接回答当前用户的问题。\n',{mode:0o600});
    }
    await rename(stage,root);
} finally { await rm(stage,{recursive:true,force:true}); }
console.log('Created configuration in '+root);
