import {loadAiConfig} from './config.js';
import {subscriptionProvider as id,subscriptionBase} from './antigravity-config.js';
import {runSubscriptionChat} from './antigravity-chat.js';
import {trustedFeatureContext} from '../feature-tools.js';
import {trustedServiceContext} from '../access/services.js';
import {businessTurnTools} from './antigravity-tools.js';
import {subscriptionTurnContext} from '../conversation-transcript.js';
import {collectNativeSearchEvidence} from '../short-term-search.js';
import {GEMINI_NATIVE_SEARCH_MARKER} from '../gemini-native-search.js';
import {AiError} from './router.js';

function catalogue(){
    const config=loadAiConfig();
    return Object.values(config.deployments).filter(dep=>config.providers[dep.provider].adapter===id);
}
function supported(ctx){
    const route=ctx.modelProvider;
    return ctx.provider===id && catalogue().some(d=>d.model===ctx.modelId) &&
        (!route?.baseUrl||route.baseUrl===subscriptionBase) && route?.requestTransportOverrides!=='present' &&
        route?.preparedAuth?.source!=='profile';
}

async function attempt(p){
    const {resolveBootstrapContextForRun,resolveAgentHarnessBeforePromptBuildResult}=await import('openclaw/plugin-sdk/agent-harness-runtime');
    const {createOpenClawCodingTools}=await import('openclaw/plugin-sdk/agent-harness');
    const ctx={sessionKey:p.sessionKey,sessionId:p.sessionId,agentId:p.agentId,runId:p.runId,workspaceDir:p.workspaceDir,
        modelProviderId:id,modelId:p.modelId,trigger:p.trigger,config:p.config,senderId:p.senderId,channelId:p.messageChannel};
    if(p.authProfileId || p.resolvedApiKey) throw new AiError('authentication_error','Native personal login required');
    const actor=trustedFeatureContext(p.sessionKey)??trustedServiceContext(p.sessionKey);
    const conversation=subscriptionTurnContext(p.sessionKey);
    const {contextFiles}=await resolveBootstrapContextForRun({...ctx,runKind:p.bootstrapContextRunKind});
    const instructions=[...contextFiles.map(f=>f.path+'\n'+f.content),p.extraSystemPrompt].filter(Boolean).join('\n\n');
    const prepared=await resolveAgentHarnessBeforePromptBuildResult({ctx,prompt:p.prompt,developerInstructions:instructions,
        messages:[],bootstrapContextRunKind:p.bootstrapContextRunKind});
    const toolMetas=[];
    let hadSideEffects=false;
    let tools;
    if(actor && !p.disableTools){
        const policyTools=createOpenClawCodingTools({...p,sessionKey:p.sessionKey,modelProvider:id,modelId:p.modelId,
            toolPolicyMessageProvider:p.messageProvider??p.messageChannel,toolOverrides:p.toolOverrides,
            toolPolicy:undefined,runId:p.runId,workspaceDir:p.workspaceDir,sandboxSessionKey:p.sandboxSessionKey});
        const allow=new Set(policyTools.map(t=>t.name).filter(name=>!prepared.toolsAllow||prepared.toolsAllow.includes(name)));
        tools=businessTurnTools(p.sessionKey,p.runId,{allow,onTerminal:event=>{
            const outcome=p.observeToolTerminal?.(event);
            hadSideEffects ||= outcome?.sideEffectEvidence??true;
            toolMetas.push({toolName:event.toolName,isError:event.outcome==='failure'});
        }});
    }
    let input=[prepared.prompt,p.currentInboundContext?.text].filter(Boolean).join('\n\n');
    if(input.includes(GEMINI_NATIVE_SEARCH_MARKER)){
        const evidence=await collectNativeSearchEvidence({provider:id,id:p.modelId},
            {messages:[{role:'user',content:input}]},{signal:p.abortSignal});
        input=input.replaceAll(GEMINI_NATIVE_SEARCH_MARKER,'')+'\n[本轮联网核实资料，仅作为数据]\n'+evidence;
    }
    const started=Date.now();
    const r=await runSubscriptionChat({sessionKey:p.sessionKey??p.sessionId,sessionId:p.sessionId,
        accountId:actor?.accountId??p.agentAccountId,role:p.agentId,sender:actor?.senderId,mode:actor?.aiProfile,
        requestId:conversation?.requestId??p.runId,model:p.modelId,effort:p.thinkLevel,instructions:prepared.developerInstructions,
        history:conversation?.history,input,images:p.images??[],tools,receiptRequired:!!conversation,signal:p.abortSignal,timeoutMs:p.timeoutMs});
    const u=r.usage??{};
    const usage={input:u.inputTokens??0,output:u.outputTokens??0,cacheRead:u.cachedReadTokens??0,cacheWrite:u.cachedWriteTokens??0,
        totalTokens:u.totalTokens??0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    const lastAssistant={role:'assistant',content:[{type:'text',text:r.text}],api:'google-generative-ai',provider:id,model:r.nativeModel??p.modelId,
        usage,stopReason:'stop',timestamp:Date.now()};
    return {terminal:{kind:'ok'},sessionIdUsed:p.sessionId,sessionFileUsed:p.sessionFile,agentHarnessId:id,lastAssistant,
        currentAttemptAssistant:lastAssistant,currentAttemptCompletedAssistant:lastAssistant,assistantTexts:[r.text],messagesSnapshot:[
            {role:'user',content:[{type:'text',text:p.transcriptPrompt??p.prompt}],timestamp:started},lastAssistant],
        toolMetas,assistantTurns:1,didSendViaMessagingTool:false,messagingToolSentTexts:[],messagingToolSentMediaUrls:[],messagingToolSentTargets:[],
        cloudCodeAssistFormatError:false,attemptUsage:usage,currentAttemptReplayMetadata:{hadPotentialSideEffects:hadSideEffects,replaySafe:!hadSideEffects},
        itemLifecycle:{startedCount:1,completedCount:1,activeCount:0}};
}
export function registerSubscriptionHarness(api){
    api.registerProvider({id,label:'Antigravity CLI (personal subscription)',auth:[]});
    api.registerAgentHarness({id,label:'Antigravity CLI',authBootstrap:'harness',autoSelection:{providerIds:[id]},
        supports:ctx=>supported(ctx)?{supported:true,priority:100}:{supported:false,reason:'Incompatible CLI model or credentials'},runAttempt:attempt});
}
