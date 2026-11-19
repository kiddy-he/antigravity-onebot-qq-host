import {onebotPath} from '../paths.js';
import {conversationProfile} from '../ai/conversation-profile.js';
import {metricsEnvironment} from '../ai/metrics.js';
import { readConversationEvidence } from '../conversation-evidence.js';
import {runImageWorkflow, imageFailedBeforeGeneration, imageFailureDiagnostic} from './image-workflow.js';
import { executeMarketTool } from './sharemarket.js';
import { ReachProvider } from './reach-provider.js';
import { formatGroupGuestQuotaResult } from "../group-guest-quota.js";
import { notifyMediaResult } from '../media-completion.js';
import {currentOwnerGrant} from '../standalone/owner-grant.js';
import {runApprovedOwnerProcess,runOwnedBusinessFile} from './owned-process.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BUSINESS_TOOLS, validateToolParams } from './catalog.js';
import { trustedFeatureContext, decideFeatureTool } from '../feature-tools.js';
import { authorizeFeature, loadFeatureConfig } from '../feature-policy.js';
import { canonical, digest, operationStore } from '../access/operations.js';
import { trustedServiceContext, authorizeServiceTool } from '../access/services.js';
import { executorSettings } from './settings.js';
import { helperAgent, scopedAgent } from '../workspaces/routes.js';
import { redactImageDiagnostic } from '../image-diagnostics.js';
import { persistArtifact, deliveryQueue } from '../delivery/queue.js';
import { resolveSpeechTarget, resolveConversationSpeechTarget } from './speech.js';
import { SPEECH_LIMIT, APPENDIX_LIMIT, speechLength, SPEECH_TOO_LONG, SPEECH_REJECTED } from './speech-policy.js';
import { reviewGuestSpeech } from './speech-review.js';
import { recordSpeechFailure } from './speech-diagnostics.js';
import { ReminderManager } from './reminders.js';
import { executeXOperation } from './x.js';
import { executeXhsOperation, observeXhsAuthResult } from './xhs.js';
import { SerialExecutor } from './serial-executor.js';
import { trustedBusinessImageApproval, boundedBusinessReview } from './business-approval.js';

const runFile = promisify(execFile);
const active = new Map();
const xhsExecutor = new SerialExecutor();
let approvalReviewer;
const approvalHandlers = new Map();
const businessResultHandlers = new Map();
const businessReviews = new Map();
const MANUAL_APPROVAL_TOOLS = new Set(['network_control', 'alas_control', 'automation_manage']);
export function setBusinessApprovalReviewer(review) { approvalReviewer = review; }
export function setBusinessApprovalHandler(accountId, handler) { approvalHandlers.set(accountId, handler); }
export function setBusinessResultHandler(accountId, handler) { businessResultHandlers.set(accountId, handler); }
export function cancelBusinessReviews({ sessionKey, accountId } = {}) {
    const ids = [];
    for (const [id, entry] of businessReviews) {
        if (sessionKey && entry.sessionKey !== sessionKey || accountId && entry.accountId !== accountId) continue;
        if (!sessionKey && !accountId) continue;
        entry.controller.abort(Object.assign(new Error('自动审查已取消，尚未执行'), { code: 'review_cancelled' }));
        const state = entry.store.get(id)?.state;
        if (state === 'reviewing' || state === 'waiting_approval') {
            entry.store.state(id, 'review_cancelled');
            entry.store.db.prepare('DELETE FROM approvals WHERE operation_id=?').run(id);
        }
        ids.push(`business-${id}`);
    }
    if(sessionKey && accountId && process.env.ONEBOT_STANDALONE==='1'){
        const store=operationStore();
        const waiting=store.db.prepare("SELECT o.id,o.kind FROM operations o JOIN admin_processes p ON o.id=p.operation_id WHERE o.state='waiting_approval' AND json_extract(o.input,'$.origin.accountId')=? AND json_extract(o.input,'$.origin.sessionKey')=?").all(accountId,sessionKey);
        for(const op of waiting){
            store.state(op.id,'review_cancelled');
            store.db.prepare('DELETE FROM approvals WHERE operation_id=?').run(op.id);
            ids.push('business-'+op.id);
        }
    }
    return ids;
}
export function recoverBusinessReviews(accountId, store = operationStore()) {
    let count = 0;
    for (const row of store.db.prepare("SELECT id FROM operations WHERE state='reviewing' AND json_extract(input,'$.origin.accountId')=?").all(accountId)) {
        if (businessReviews.has(row.id)) continue;
        store.state(row.id, 'review_cancelled', {operationId:row.id,status:'review_cancelled',error:'上次自动审查已中断，尚未执行；不会自动恢复或发送审批。'});
        count++;
    }
    return count;
}
export function pendingBusinessApprovals(store = operationStore()) {
    return store.db.prepare("SELECT * FROM operations WHERE state='waiting_approval' AND created>?").all(Date.now() - 600000)
        .map(row => ({ id: `business-${row.id}`, operationId: row.id, ...JSON.parse(row.input) }));
}
export function businessMediaAuthorization(sessionKey, path, context, store = operationStore()) {
    if (!context?.requestId) return null;
    const rows = store.db.prepare("SELECT input,result FROM operations WHERE state='succeeded' AND json_extract(input,'$.origin.sessionKey')=? AND json_extract(input,'$.origin.requestId')=? ORDER BY updated DESC LIMIT 20").all(sessionKey, String(context.requestId));
    for (const row of rows) {
        const input = JSON.parse(row.input);
        if (String(input.origin.senderId) !== String(context.senderId) || input.origin.accountId !== context.accountId) continue;
        const output = JSON.parse(row.result)?.output ?? '';
        const paths = [...output.matchAll(/^(?:image_output|audio_output|PATH|IMAGE)=(.+)$/gmu)].map(match => match[1].trim());
        if (paths.includes(path)) return { feature: BUSINESS_TOOLS[input.name].feature, action: BUSINESS_TOOLS[input.name].action, context: input.origin };
    }
    return null;
}
export function speechFallbackForTurn(sessionKey, context, store = operationStore()) {
    if (!context?.requestId) return null;
    const rows = store.db.prepare("SELECT input,result FROM operations WHERE kind='tts_synthesize' AND state IN ('succeeded','uncertain','failed') AND result IS NOT NULL AND json_extract(input,'$.origin.sessionKey')=? AND json_extract(input,'$.origin.requestId')=? ORDER BY updated DESC LIMIT 5").all(sessionKey, String(context.requestId));
    for (const row of rows) {
        const input = JSON.parse(row.input), result = JSON.parse(row.result);
        if (input.origin.accountId === context.accountId && String(input.origin.senderId) === String(context.senderId) && result.textOnly)
            return result;
    }
    return null;
}
export function speechDeliveryForTurn(sessionKey, context, store = operationStore()) {
    if (!context?.requestId) return null;
    const rows = store.db.prepare("SELECT id,input,result FROM operations WHERE kind='tts_synthesize' AND state='succeeded' AND result IS NOT NULL AND json_extract(input,'$.origin.sessionKey')=? AND json_extract(input,'$.origin.requestId')=? ORDER BY updated DESC LIMIT 5").all(sessionKey, String(context.requestId));
    for (const row of rows) {
        const input = JSON.parse(row.input), origin = input.origin, value = JSON.parse(row.result);
        if (origin.accountId === context.accountId && String(origin.senderId) === String(context.senderId)
            && origin.scope === context.scope && String(origin.groupId) === String(context.groupId)
            && value.delivered === true && value.deliveryId)
            return { operationId: row.id, deliveryId: value.deliveryId, status: 'accepted', text: input.params?.text };
    }
    return null;
}
export function marketDeliveryForTurn(sessionKey,context,store=operationStore()) {
    if(!context?.requestId||!context.sharemarketOperation)return null;
    const rows=store.db.prepare("SELECT id,kind,state,input,result FROM operations WHERE json_extract(input,'$.origin.sessionKey')=? AND json_extract(input,'$.origin.requestId')=? ORDER BY updated").all(sessionKey,String(context.requestId));
    const own=rows.filter(row=>{const origin=JSON.parse(row.input).origin;return origin.accountId===context.accountId&&String(origin.senderId)===String(context.senderId)&&origin.scope===context.scope&&String(origin.groupId)===String(context.groupId);});
    if(!own.length||own.some(row=>!BUSINESS_TOOLS[row.kind]?.marketOperation||row.state!=='succeeded'||!row.result))return null;
    const completed=own.map(row=>({row,value:JSON.parse(row.result)}));
    if(completed.some(({value})=>!value.market?.delivered||!value.market.suppressSummary))return null;
    const last=completed.at(-1);return {operationId:last.row.id,deliveryId:last.value.market.deliveryId,text:'[虚拟股市操作结果已由专用工具交付]'};
}
export async function resolveBusinessApproval(id, allowed, approver, { store = operationStore(), run } = {}) {
    const op = store.get(String(id).replace(/^business-/u, ''));
    if (!op || op.state !== 'waiting_approval' || op.created < Date.now() - 600000) throw new Error('业务审批不存在、已执行或已过期');
    const input = JSON.parse(op.input), origin = input.origin;
    if (!authorizeFeature(loadFeatureConfig(), 'system', 'approve', approver).allowed || origin.accountId !== approver.accountId || origin.scope !== approver.scope
        || (origin.scope === 'group' && String(origin.groupId) !== String(approver.groupId))) throw new Error('审批来源与原操作不一致');
    const owned=store.db.prepare('SELECT owner FROM admin_processes WHERE operation_id=?').get(op.id);
    if((owned || BUSINESS_TOOLS[input.name]?.ownerCommand) && (origin.scope!=='private'||String(origin.senderId)!==String(approver.senderId)))throw Error('此次机主操作只能由原私聊发起人确认');
    if (!allowed) { store.state(op.id, 'denied'); return { operationId: op.id, status: 'denied' }; }
    if(owned && !currentOwnerGrant(origin.sessionKey,origin,owned.owner))throw Error('机主会话或命令授权已失效');
    if(owned || BUSINESS_TOOLS[input.name]?.ownerCommand)prepare(input.name,input.params,origin,origin.callId,origin.sessionKey,store);
    store.approve(op.id, op.fingerprint, 'allow-once');
    return (await runApprovedOwnerProcess({name:input.name,params:input.params,context:origin,callId:origin.callId,
        sessionKey:origin.sessionKey,operationId:op.id,store,run},executeBusinessTool)).details;
}
export function redactResult(value) {
    return redactImageDiagnostic(String(value ?? '').replace(/((?:cookie|skey|p_skey)\s*["']?\s*[:=]\s*["']?)[^\r\n]+/giu, '$1[REDACTED]'), 40000);
}
function operationInput(name, params, context, command, sessionKey, callId) {
    return { name, params, command, origin: { senderId: context.senderId, accountId: context.accountId, scope: context.scope,
        groupId: context.groupId, explicit: context.explicit, roleCount: context.roleCount, originJobId: context.originJobId,
        requestId: context.requestId, receivedAt: context.receivedAt, reminderAction: context.reminderAction,
        mediaPaths: context.mediaPaths, workspaceAgentId: context.workspaceAgentId, sessionKey, callId } };
}
export {prepare as prepareBusinessTool};
function prepare(name, params, context, callId, sessionKey, store) {
    const base = BUSINESS_TOOLS[name];
    const settings = executorSettings()[name];
    if (!settings?.enabled) throw new Error("executor disabled");
    const specification = { ...base, ...settings };
    if (!specification || !context || !callId) throw new Error('missing trusted business context');
    const config = loadFeatureConfig();
    const decision = context.actorType === "service" ? { allowed: authorizeServiceTool(context, specification, config), reason: "service_capability_denied" } : decideFeatureTool(config, name, params, context);
    if (!decision.allowed) throw new Error(`permission denied: ${decision.reason}`);
    if (specification.speech && context.actorType === 'service') resolveSpeechTarget(context);
    const normalized = specification.reachOperation ? specification.reachValidate(params) : specification.xhsOperation ? specification.xhsValidate(params) : specification.xOperation ? specification.xValidate(params) : validateToolParams(specification, params);
    const command = specification.build(normalized, { ...context,
        authorizedBusinessMedia: path => businessMediaAuthorization(sessionKey, path, context, store) !== null }, config);
    const nativeReply = name === 'qzone_interact' && normalized.action === 'reply';
    const rootComment = name === 'qzone_interact' && normalized.action === 'comment';
    const id = ['xhs_job_status','xhs_read_artifact','xhs_send_media'].includes(name) ? digest({sessionKey,requestId:context.requestId,name,callId,params:normalized}) : nativeReply
        ? digest({ name, accountId: context.accountId, target: normalized.target, tid: normalized.tid, commentId: normalized.commentId, replyUin: normalized.replyUin })
        : name === 'reminder_create' && context.requestId ? digest({ name, scope: context.scope, peer: context.scope === 'group' ? String(context.groupId) : String(context.senderId), senderId: String(context.senderId), requestId: String(context.requestId) })
        : context.requestId ? digest({ sessionKey, requestId: String(context.requestId), name,
            params: rootComment ? { action: 'comment', target: normalized.target, tid: normalized.tid } : normalized }) : digest({ sessionKey, callId, name });
    const existing = store.get(id);
    if(existing && specification.ownerCommand){
        const handle=store.db.prepare('SELECT owner FROM admin_processes WHERE operation_id=?').get(id);
        if(handle && !currentOwnerGrant(sessionKey,context,handle.owner))throw Error('机主会话或命令授权已失效');
    }
    if (existing && (nativeReply || rootComment)) {
        const original = JSON.parse(existing.input);
        // Rewording must not create another write or bypass target deduplication.
        // Cross-request hits reveal only status, not content.
        if (canonical(original.params) !== canonical(normalized) || original.origin.senderId !== context.senderId
            || original.origin.sessionKey !== sessionKey || String(original.origin.requestId) !== String(context.requestId))
            throw new Error(`该目标的回复已有记录（${existing.state}），未创建新操作或重复发送；请先核对原操作，不要改写后重试。`);
        return { specification, command: original.command, operation: existing, normalized };
    }
    if (!existing && name!=='owner_inspect' && (specification.approval || specification.mutation) && store.db.prepare("SELECT id FROM operations WHERE state='uncertain' AND kind=? AND json_extract(input,'$.origin.accountId')=? AND json_extract(input,'$.params')=? LIMIT 1").get(name, context.accountId, canonical(normalized)))
        throw new Error('同账号的相同写操作存在不确定结果，需先核对原操作；未重复执行。');
    // A repeated model tool call in the same actual message is the same business
    // operation even when the model/runtime allocates another tool-call id.
    const originalCallId = existing ? JSON.parse(existing.input).origin.callId : callId;
    if (name === 'tts_synthesize' && context.requestId && !existing) {
        const prior = store.db.prepare("SELECT id FROM operations WHERE json_extract(input,'$.origin.sessionKey')=? AND json_extract(input,'$.origin.requestId')=? AND kind='tts_synthesize' LIMIT 1").get(sessionKey, String(context.requestId));
        if (prior) throw new Error('本条请求已有语音处理或文字回退，不再改写、分段或重复合成。');
    }
    if (specification.feature === 'images' && context.requestId && !existing) {
        const prior = store.db.prepare("SELECT id FROM operations WHERE json_extract(input,'$.origin.sessionKey')=? AND json_extract(input,'$.origin.requestId')=? AND kind IN ('onebot_image_generate','image_edit','image_reference','agy_image_probe') LIMIT 1").get(sessionKey, String(context.requestId));
        if (prior) throw new Error('本条请求已有生图工作流，未发起额外收费生成；请先核对原操作。');
    }
    const input = operationInput(name, normalized, context, command, sessionKey, originalCallId);
    return { specification, command, operation: store.begin(name, input, id), normalized };
}
export async function executeBusinessTool(input) {
    if (BUSINESS_TOOLS[input.name]?.xOperation || BUSINESS_TOOLS[input.name]?.reachOperation) {
        const deadline=AbortSignal.timeout(executorSettings()[input.name].timeoutMs);
        return executeBusinessToolNow({...input,signal:input.signal?AbortSignal.any([input.signal,deadline]):deadline});
    }
    if (!BUSINESS_TOOLS[input.name]?.xhsOperation) return executeBusinessToolNow(input);
    const store = input.store ?? operationStore();
    // Check permission before admission; recheck it after waiting in prepare().
    const { specification, operation } = prepare(input.name, input.params, input.context, input.callId, input.sessionKey, store);
    if (['succeeded','running','uncertain','failed'].includes(operation.state)) return executeBusinessToolNow({...input,store});
    const deadline = AbortSignal.timeout(specification.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal,deadline]) : deadline;
    if(specification.xhsOperation==='media_workflow') return executeBusinessToolNow({...input,store,signal,xhsRunStep:async task=>{
        const release=await xhsExecutor.acquire(signal);
        try {signal.throwIfAborted();return await task();} finally {release();}
    }});
    let release;
    try { release = await xhsExecutor.acquire(signal); }
    catch (error) {
        const value = {operationId:operation.id,status:'not_executed',error:signal.aborted
            ? (deadline.aborted ? '小红书排队等待已超时，尚未执行。' : '小红书等待任务已取消，尚未执行。')
            : error.message === 'xhs_queue_full' ? '小红书等待队列已满，尚未执行。' : '小红书等待任务未执行。'};
        return {content:[{type:'text',text:JSON.stringify(value)}],details:value,isError:true};
    }
    try {
        signal.throwIfAborted();
        return await executeBusinessToolNow({...input,store,signal});
    } finally { release(); }
}
async function executeBusinessToolNow({ name, params, context, callId, sessionKey, signal, store = operationStore(), run = runFile, speechReview = reviewGuestSpeech, getDeliveryQueue = deliveryQueue, recordSpeechError = recordSpeechFailure, reminderMembers, xhsExecute = executeXhsOperation, xhsRunStep, xExecute = executeXOperation, reachExecute = (name,params,options)=>new ReachProvider().execute(name,params,options), marketExecute = executeMarketTool }) {
    const { specification, command, operation, normalized } = prepare(name, params, context, callId, sessionKey, store);
    const aiProfile = conversationProfile({sessionKey, workspaceAgentId:context.workspaceAgentId,
        mode:context.aiProfile === 'isolated' ? 'nsfw' : undefined});
    const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value, isError: value.status !== 'succeeded' });
    if (specification.marketOperation && ['running','uncertain','succeeded'].includes(operation.state)) {
        // Domain idempotency makes recovery safe even after a lost CLI/socket reply.
        // Replay the original ID; the Python service returns the committed result.
        try {
            const market=await marketExecute(specification.marketOperation,normalized,context,{operationId:operation.id,queue:getDeliveryQueue(),signal,action:specification.action,sessionKey});
            const value={operationId:operation.id,status:market.ok?'succeeded':'failed',market};
            store.state(operation.id,value.status,value);return result(value);
        } catch(error) {
            const value={operationId:operation.id,status:'uncertain',error:'原股市操作结果待核对，请勿重新下单。'};
            store.state(operation.id,'uncertain',value);return result(value);
        }
    }
    if (operation.state === 'succeeded') {
        const value=JSON.parse(operation.result);
        if (specification.xOperation==='media_workflow') await notifyMediaResult({...context,sessionKey},'x',value.x);
        if (specification.xhsOperation==='media_workflow') await notifyMediaResult({...context,sessionKey},'xiaohongshu',value.xhs);
        return result(value);
    }
    if (['running', 'uncertain', 'failed'].includes(operation.state)) return result({ operationId: operation.id, status: operation.state, error: '操作已有记录，未重复执行；结果不确定时需先核对。' });
    const key = `${specification.feature}:${specification.xhsOperation==='media_workflow'?'workflow:':''}${context.accountId}`;
    if ((active.get(key) ?? 0) >= specification.maxConcurrent) return result({ operationId: operation.id, status: 'not_executed', error: '该功能当前正在执行，请稍后重试。' });
    if (specification.approval && !store.consumeApproval(operation.id, operation.fingerprint))
        return result({ operationId: operation.id, status: 'not_executed', error: '缺少与本次操作参数绑定的有效审批。' });
    const claimed = store.db.prepare("UPDATE operations SET state='running',updated=? WHERE id=? AND state IN ('pending','waiting_approval')").run(Date.now(), operation.id).changes;
    if (!claimed) return result({ operationId: operation.id, status: 'not_executed', error: '操作已由其他执行器处理，未重复执行。' });
    active.set(key, (active.get(key) ?? 0) + 1);
    store.state(operation.id, 'running');
    try {
        if (specification.contextEvidence) {
            const value=await readConversationEvidence({sessionKey,agentId:sessionKey.split(':')[1],...normalized});
            store.state(operation.id,'succeeded',value);return result(value);
        }
        if (specification.marketOperation) {
            const market = await marketExecute(specification.marketOperation, normalized, context, {operationId:operation.id,queue:getDeliveryQueue(),signal,action:specification.action,sessionKey});
            const value={operationId:operation.id,status:market.ok?'succeeded':'failed',market};
            store.state(operation.id,value.status,value);return result(value);
        }
        if (specification.reachOperation) {
            const reach = await reachExecute(specification.reachOperation, normalized, {signal});
            if(name.startsWith('reach_xhs_')&&!reach.ok&&['NEED_LOGIN','PLATFORM_BLOCKED'].includes(reach.error?.code)){
                await observeXhsAuthResult({version:1,operation:'search',ok:false,data:null,error:{code:reach.error.code==='NEED_LOGIN'?'login_required':'challenge_required'}},{...context,sessionKey});
            }
            const value={operationId:operation.id,status:reach.ok?'succeeded':'failed',reach};
            store.state(operation.id,value.status,value);return result(value);
        }
        if (specification.xOperation) {
            const x = await xExecute(specification.xOperation,normalized,{...context,sessionKey},{signal,operationId:operation.id,queue:getDeliveryQueue(),onStage:t=>console.info(`[onebot-x] stage=${t.stage} elapsed_ms=${t.elapsed_ms}`)});
            const value={operationId:operation.id,status:x.ok?'succeeded':['uncertain','native_pending','dispatching','ready'].includes(x.data?.delivery_status)?'uncertain':'failed',x};
            store.state(operation.id,value.status,value);
            if(specification.xOperation==='media_workflow') await notifyMediaResult({...context,sessionKey},'x',x);
            return result(value);
        }
        if (specification.xhsOperation) {
            const xhs = await xhsExecute(specification.xhsOperation, normalized, {...context,sessionKey}, { callId, signal, operationId: operation.id, runStep:xhsRunStep });
            const value = { operationId: operation.id, status: xhs.ok && xhs.data?.state !== 'failed' ? 'succeeded' : 'failed', xhs };
            store.state(operation.id, value.status, value);
            if(specification.xhsOperation==='media_workflow') await notifyMediaResult({...context,sessionKey},'xiaohongshu',xhs);
            return result(value);
        }
        if (specification.feature === 'reminders') {
            const manager = new ReminderManager({ store, ...(reminderMembers ? { members: reminderMembers } : {}) });
            const reminder = name === 'reminder_create' ? await manager.create(params, context, operation.id)
                : name === 'reminder_list' ? { reminders: manager.list(context) } : manager.cancel(params.reminderId, context);
            const value = { operationId: operation.id, status: 'succeeded', ...reminder };
            store.state(operation.id, 'succeeded', value);
            return result(value);
        }
        if (name === 'tts_synthesize') {
            const limit = context.speechAppendix ? APPENDIX_LIMIT : SPEECH_LIMIT;
            if (speechLength(params.text) > limit) {
                const value = { operationId: operation.id, status: 'succeeded', textOnly: true, output: '',
                    ...(context.speechAppendix ? { safeReply: '' } : { fallbackText: params.text, notice: SPEECH_TOO_LONG }) };
                store.state(operation.id, 'succeeded', value); return result(value);
            }
            const policy = loadFeatureConfig();
            const isGuest = context.actorType === 'service' ? resolveSpeechTarget(context).target.type === 'group'
                : !policy.identities.adminIds.includes(String(context.senderId));
            if (isGuest) {
                const review = await speechReview(params.text, {aiProfile, signal});
                signal?.throwIfAborted();
                if (review.allow !== true) {
                    const value = { operationId: operation.id, status: 'succeeded', textOnly: true, output: '',
                        safeReply: context.speechAppendix ? '' : review.reason === 'review_unavailable'
                            ? '语音检查这次没有完成，暂时无法生成语音。' : SPEECH_REJECTED, review: review.reason };
                    store.state(operation.id, 'succeeded', value); return result(value);
                }
            }
        }
        // No shell, fixed executable, bounded argv, timeout and output.
        signal?.throwIfAborted();
        const runOptions = { timeout: specification.timeoutMs, maxBuffer: 1024 * 1024,
            ...(signal ? { signal } : {}),
            cwd: onebotPath(), env: { ...process.env, ...metricsEnvironment(), ONEBOT_OPERATION_ID: operation.id, ONEBOT_AI_PROFILE: aiProfile ?? '', ONEBOT_IMAGE_HELPER_AGENT_ID: helperAgent(context.workspaceAgentId ?? scopedAgent({ scope: 'automation', conversationId: 'public', roleAgentId: context.accountId === 'yuexia' ? 'onebot-yuexia' : 'main' }), 'rewrite') }, shell: false };
        const output = specification.feature === 'images' ? await runImageWorkflow(command, runOptions, run,
            name==='agy_image_probe'?path=>persistArtifact(path,store):undefined) : await run(command.file, command.argv, runOptions);
        const value = { operationId: operation.id, status: 'succeeded', feature: specification.feature, action: specification.action,
            output: specification.feature === 'quota'
                ? formatGroupGuestQuotaResult(specification.action === 'refresh' ? 'refresh' : 'quota', output.stdout)
                : redactResult(output.stdout).slice(0, 40000),
            ...(specification.feature === 'quota' ? { replyInstruction: '仅报告这三个模型的5小时配额和周配额。以当前角色人设组织回复，完整保留返回的百分比、重置时间、未知和缓存状态，说明Gemini两模型共用配额组。不要列出其他模型或将模型汇总百分比解释成单个时间窗口。' } : {}) };
        if(name==='agy_diagnostic' && normalized.action==='models'){
            const {taskId,routeId,steps}=JSON.parse(output.stdout);
            value.output=JSON.stringify({taskId,routeId,steps:steps.map(({deploymentId,adapter,model,timeoutMs})=>({deploymentId,adapter,model,timeoutMs}))});
        }
        if (specification.feature === 'images') {
            if (output.imageWorkflow) value.workflow = output.imageWorkflow;
            if (!/^image_output=\S.+$/mu.test(value.output)) {
                value.status = imageFailedBeforeGeneration({imageWorkflow:output.imageWorkflow}) ? 'failed' : 'uncertain';
                value.error = 'image_output_missing';
                if (value.status === 'failed') { value.failureStage = output.imageWorkflow.phase; value.diagnostic = imageFailureDiagnostic(`${output.stdout ?? ''}\n${output.stderr ?? ''}`, output.imageWorkflow.phase); }
            }
        }
        // Script exit 0 with an explicit failure is still a business failure.
        if (/(?:^|\n)(?:STATUS=fail|(?:ok|success)[=:]\s*false)/iu.test(value.output) || /^\s*\{[\s\S]*"ok"\s*:\s*false/u.test(value.output)) value.status = 'failed';
        if (name === 'tts_synthesize' && value.status === 'succeeded') {
            signal?.throwIfAborted();
            const generated = JSON.parse(output.stdout);
            if (generated.ok !== true || generated.preset !== 'elysia-light-v1' || typeof generated.audio_output !== 'string') throw new Error('TTS 未返回有效成品');
            const managed = await persistArtifact(generated.audio_output, store);
            value.output = `audio_output=${managed}\nvoice=elysia\n`;
            if (context.actorType !== 'service' && context.speechDelivery === 'bound-conversation') {
                // Delivery is owned by the trusted tool, not by the model's
                // ability to render MEDIA directives in its subsequent reply.
                value.output = '';
                try {
                    signal?.throwIfAborted();
                    const target = resolveConversationSpeechTarget(context);
                    const origin = JSON.parse(operation.input).origin;
                    const delivery = await getDeliveryQueue().enqueue({ ...target, context: origin,
                        parts: [{ type: 'record', path: managed }], operationId: operation.id,
                        workspaceAgentId: context.workspaceAgentId, sessionKey, dedupeKey: `tts:${operation.id}` });
                    value.deliveryId = delivery.id;
                    value.delivered = delivery.state === 'accepted';
                    value.deliveryStatus = delivery.state;
                } catch { value.delivered = false; value.deliveryStatus = 'unconfirmed'; }
                if (!value.delivered) {
                    value.status = 'uncertain'; value.textOnly = true;
                    value.safeReply = `这次语音还没能确认送达，我先用文字告诉你：\n${params.text}`;
                }
            }
            if (context.actorType === 'service') {
                signal?.throwIfAborted();
                const target = resolveSpeechTarget(context);
                const delivery = await deliveryQueue().enqueue({ ...target, speechService: true, parts: [{ type: 'record', path: managed }],
                    workspaceAgentId: context.workspaceAgentId, sessionKey, dedupeKey: `tts:${operation.id}` });
                value.output = '';
                value.delivered = delivery.state === 'accepted';
                value.deliveryId = delivery.id;
                if (!value.delivered) { value.status = 'uncertain'; value.error = '语音投递尚未确认，请勿重复生成或发送。'; }
            }
        }
        if (value.status === 'succeeded' && ((specification.feature === 'images' && name!=='agy_image_probe') || name === 'alas_screenshot')) {
            const paths = [...value.output.matchAll(/^(image_output|PATH|IMAGE)=(.+)$/gmu)];
            for (const match of paths) {
                const managed = await persistArtifact(match[2].trim(), store);
                value.output = value.output.replace(match[0], `${match[1]}=${managed}`);
            }
        }
        store.state(operation.id, value.status, value);
        return result(value);
    } catch (error) {
        if (name === 'tts_synthesize') {
            const diagnostic = await recordSpeechError(error, operation.id);
            const value = { operationId: operation.id, status: 'failed', output: '', textOnly: true,
                error: `speech_${diagnostic.reason}`, failureStage: diagnostic.stage,
                safeReply: context.speechAppendix ? '' : `这次语音没有生成成功，我先用文字告诉你：\n${params.text}` };
            store.state(operation.id, 'failed', value);
            return result(value);
        }
        // An exited wrapper can still have reached the upstream before losing
        // its reply. Only a definite spawn failure proves a write never began.
        const neverStarted = ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) && !error.stdout;
        const preGenerationFailure = specification.feature === 'images' && imageFailedBeforeGeneration(error);
        const status = name!=='owner_inspect' && (specification.approval || specification.mutation) && !neverStarted && !preGenerationFailure ? 'uncertain' : 'failed';
        const value = { operationId: operation.id, status, error: redactResult(error.stderr || error.message).slice(0, 2000),
            ...(specification.feature === 'images' && error.imageWorkflow ? {workflow: error.imageWorkflow} : {}),
            ...(preGenerationFailure ? {diagnostic: imageFailureDiagnostic(`${error.stdout ?? ''}\n${error.stderr ?? ''}`, error.imageWorkflow.phase), failureStage: error.imageWorkflow.phase, replyInstruction: '图片生成前的准备步骤失败，尚未提交生图请求。不要声称已生成、已修复或已发送；不要自行修改脚本或改写参数重试。'} : {}) };
        store.state(operation.id, status, value);
        return result(value);
    } finally { active.set(key, active.get(key) - 1); }
}

export function registerBusinessTools(api, { getStore = operationStore, reviewTimeoutMs = 90000, executeReviewed = executeBusinessTool } = {}) {
    for (const [name, specification] of Object.entries(BUSINESS_TOOLS)) {
        api.registerTool(ctx => {
            if(specification.ownerCommand && !ctx.onebotOwnedProcess)return null;
            // Factory visibility is not authorization; execute rechecks the event-bound identity.
            const context = trustedFeatureContext(ctx.sessionKey) ?? trustedServiceContext(ctx.sessionKey);
            if (!context) return null;
            const config = loadFeatureConfig();
            if (!executorSettings()[name].enabled) return null;
            // Keep the optional tool registered for service capability lists;
            // execution still checks the actual per-turn intent below/in hooks.
            const visibility = specification.speech ? { ...context, speechMode: undefined } : context;
            if (context.actorType === 'service' ? !authorizeServiceTool(visibility, specification, config) : !decideFeatureTool(config, name, {}, visibility).allowed) return null;
            return { name, label: name, description: specification.description, parameters: specification.parameters,
                execute: async (id, params, signal) => {
                    try { return await executeBusinessTool({ name, params, context: trustedFeatureContext(ctx.sessionKey) ?? trustedServiceContext(ctx.sessionKey), callId: id, sessionKey: ctx.sessionKey,
                        ...(ctx.onebotOwnedProcess ? {run: runOwnedBusinessFile} : {}),
                        ...((signal instanceof AbortSignal && (ctx.onebotOwnedProcess || name === 'tts_synthesize' || specification.feature==='quota' || BUSINESS_TOOLS[name]?.xhsOperation || BUSINESS_TOOLS[name]?.xOperation || BUSINESS_TOOLS[name]?.reachOperation || BUSINESS_TOOLS[name]?.marketOperation)) ? { signal } : {}), store: getStore() }); }
                    catch (error) { return { isError: true, content: [{ type: 'text', text: `业务工具未执行：${redactResult(error.message)}` }] }; }
                } };
        }, { names: [name] });
    }
    api.on('before_tool_call', async (event, ctx) => {
        if (!BUSINESS_TOOLS[event.toolName]?.approval) return;
        try {
            const context = trustedFeatureContext(ctx.sessionKey) ?? trustedServiceContext(ctx.sessionKey);
            const store = getStore();
            const prepared = prepare(event.toolName, event.params, context, event.toolCallId, ctx.sessionKey, store);
            if (prepared.operation.state === 'succeeded') return;
            if (prepared.operation.state !== 'pending') return { block: true, blockReason: `原操作状态为 ${prepared.operation.state}，未重复执行或创建审批。等待审批时请引用原消息确认或取消；不确定结果需先核对。` };
            // Reuse the existing quorum reviewer, including its trusted fixed-script rules.
            const command = [prepared.command.file, ...prepared.command.argv].map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
            const trusted = trustedBusinessImageApproval(event.toolName, prepared.command);
            if (trusted) {
                store.approve(prepared.operation.id, prepared.operation.fingerprint, 'allow-once');
                api.logger?.info?.(`Trusted business image decision=allow tool=${event.toolName} operation=${prepared.operation.id}`);
                return;
            }
            // General reviews run independently of the host's 15-second hook.
            // Claim exactly once; retries see reviewing and cannot start a new vote.
            const claimed = store.db.prepare("UPDATE operations SET state='reviewing',updated=? WHERE id=? AND state='pending'")
                .run(Date.now(), prepared.operation.id).changes;
            if (!claimed) return { block: true, blockReason: '原操作已在审查或处理，未重复执行。' };
            store.state(prepared.operation.id, 'reviewing');
            const controller = new AbortController(), reviewer = approvalReviewer;
            const entry = {controller,sessionKey:ctx.sessionKey,accountId:context.accountId,store};
            businessReviews.set(prepared.operation.id, entry);
            const current = () => !controller.signal.aborted && store.get(prepared.operation.id)?.state === 'reviewing';
            void Promise.resolve().then(async () => {
                try {
                    const review = await boundedBusinessReview(signal => reviewer?.({command,sessionKey:ctx.sessionKey,signal}, api.logger, {accountId:context.accountId}),
                        {signal:controller.signal,timeoutMs:Math.min(reviewTimeoutMs,Math.max(1,prepared.operation.created + 600000 - Date.now()))});
                    if (!current()) return;
                    // Revalidate the original actor, params and current grants,
                    // never whichever turn happens to occupy this session now.
                    prepare(event.toolName, event.params, context, event.toolCallId, ctx.sessionKey, store);
                    if (!current()) return;
                    const handler = approvalHandlers.get(context.accountId);
                    const report = businessResultHandlers.get(context.accountId);
                    if (review?.decision === 'allow' && !MANUAL_APPROVAL_TOOLS.has(event.toolName) && report) {
                        const owned=store.db.prepare('SELECT owner FROM admin_processes WHERE operation_id=?').get(prepared.operation.id);
                        if(owned && !currentOwnerGrant(ctx.sessionKey,context,owned.owner))throw Error('机主会话或命令授权已失效');
                        store.state(prepared.operation.id, 'waiting_approval');
                        store.approve(prepared.operation.id, prepared.operation.fingerprint, 'allow-once');
                        businessReviews.delete(prepared.operation.id);
                        const result = await runApprovedOwnerProcess({name:event.toolName,params:event.params,context,callId:event.toolCallId,
                            sessionKey:ctx.sessionKey,operationId:prepared.operation.id,store},executeReviewed);
                        await report({name:event.toolName,context,sessionKey:ctx.sessionKey,result:result.details});
                    } else {
                        if (!handler) throw new Error('业务审批投递处理器不可用，操作未执行');
                        store.state(prepared.operation.id, 'waiting_approval');
                        await handler({id:`business-${prepared.operation.id}`,operationId:prepared.operation.id,command,sessionKey:ctx.sessionKey,context,toolName:event.toolName,review,signal:controller.signal});
                    }
                } catch (error) {
                    if (store.get(prepared.operation.id)?.state === 'reviewing') {
                        const status = error?.code === 'review_expired' ? 'review_expired' : controller.signal.aborted ? 'review_cancelled' : 'review_failed';
                        const result = {operationId:prepared.operation.id,status,error:redactResult(error.message)};
                        store.state(prepared.operation.id,status,result);
                        // A timeout gets a factual terminal result, never a late
                        // approval prompt or an automatic execution.
                        if (!controller.signal.aborted) await businessResultHandlers.get(context.accountId)?.({name:event.toolName,context,sessionKey:ctx.sessionKey,result});
                    }
                    api.logger?.error?.(`Business review ended operation=${prepared.operation.id}: ${redactResult(error.message)}`);
                } finally { if (businessReviews.get(prepared.operation.id) === entry) businessReviews.delete(prepared.operation.id); }
            }).catch(error => api.logger?.error?.(`Business review notification failed operation=${prepared.operation.id}: ${redactResult(error.message)}`));
            return { block: true, blockReason: '操作尚未执行，已进入独立后台审查（最长90秒）。请告知用户正在审查，不能称为生图接口故障；审查通过后自动回报执行结果，需要人工确认时另发唯一审批消息。勿改写参数重试。' };
        } catch (error) { return { block: true, blockReason: `业务操作未执行：${redactResult(error.message)}` }; }
    }, { priority: 900 });
}
