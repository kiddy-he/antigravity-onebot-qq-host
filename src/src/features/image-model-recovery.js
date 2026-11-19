import {imagePreparationFailureText} from './image-workflow.js';
/** Recover only image orchestration transport failures before any image tool executes. */
import {operationStore} from '../access/operations.js';
import {setTimeout as delay} from 'node:timers/promises';
const IMAGE_KINDS = new Set(['onebot_image_generate','image_edit','image_reference']);
export function imageOperationsForTurn(sessionKey, context, store) {
    if (!context.requestId || !sessionKey || !context.accountId) return {available:false, operations:[]};
    try {
        store ??= operationStore();
        const rows = store.db.prepare(`SELECT id,kind,state,result FROM operations
          WHERE json_extract(input,'$.origin.sessionKey')=? AND json_extract(input,'$.origin.requestId')=?
          AND json_extract(input,'$.origin.accountId')=? ORDER BY created`).all(sessionKey,String(context.requestId),context.accountId);
        const operations = rows.filter(row=>IMAGE_KINDS.has(row.kind)).map(row=>({...row,result:row.result?JSON.parse(row.result):null}));
        return {available:true,operations};
    } catch { return {available:false,operations:[]}; }
}
/** A recovery is an internal attempt of the same business request, not a new QQ event. */
export function imageModelAttemptContext(context, routeIndex, retry = 0) {
    const clone = {...context};
    if (routeIndex === undefined) return clone;
    if (!Number.isInteger(routeIndex) || routeIndex < 0 || !Number.isInteger(retry) || retry < 0 || !context.MessageSid) throw new Error('Invalid image recovery identity');
    for (const key of ['MessageSid','MessageSidFull','MessageSidFirst','MessageSidLast'])
        if (clone[key] !== undefined) clone[key] = `${clone[key]}:image-recovery:${routeIndex+1}:${retry}`;
    // Native dispatch stamps its source identity privately. Retain all policy scope symbols.
    for (const key of Object.getOwnPropertySymbols(clone))
        if (key.description === 'openclaw.channelSourceTurnId') delete clone[key];
    return clone;
}
export function imageReplyOutcome({failure, state, hasMedia = false, text = ''}) {
    if (failure) return {failure};
    if (!state?.available) return {failure:{kind:'image_state_unavailable',retryable:false}};
    const mediaUrls = [...new Set(state.operations.filter(op=>op.state === 'succeeded')
        .flatMap(op=>[...String(op.result?.output ?? '').matchAll(/^image_output=(.+)$/gmu)].map(match=>match[1].trim())))];
    if (mediaUrls.length) return {mediaUrls};
    if (state.operations.length) return {failure:{kind:'image_tool_incomplete',retryable:false}};
    if (hasMedia) return {failure:{kind:'unverified_image_media',retryable:false}};
    return {failure:typeof text === 'string' && text.trim() ? {kind:'image_not_executed',retryable:false} : {kind:'empty_output',retryable:true}};
}
export function imageRecoveryStatus(failure, state) {
    // Prefer executor evidence when preparation already failed. A later model
    // refusal must not misattribute a reference lookup failure to the image API.
    if (state?.available && state.operations?.length && state.operations.every(op => op.state === 'failed')) {
        const explanation = imagePreparationFailureText(state.operations.at(-1).result);
        if (explanation) return explanation;
    }
    if (failure?.kind === 'policy_blocked') {
        if (state?.operations.some(op=>op.state === 'succeeded')) return '图片已有生成成功记录，但后续回复被上游拒绝，尚未确认送达；我没有重新生成。';
        if (state?.operations.length) return '生图处理被上游的内容安全规则拒绝，已有执行记录，图片结果未确认；我没有重新生成。';
        return '这次生图请求被上游的内容安全规则拒绝，没有完成生成。可以调整请求后再试。';
    }
    if (failure?.kind === 'unverified_image_media') return '这次回复中的图片没有对应的已完成生成记录，尚未发送，也没有自动重新生成。';
    if (failure?.kind === 'image_not_executed') return '这次未能启动图片生成，没有生成或发送图片。可以调整请求后再试。';
    if (!state?.available) return '这次生图未能完成，执行状态暂时无法核实，已停止自动重试以免重复生成。';
    if (state.operations.some(op=>op.state === 'succeeded')) return '图片已生成，但后续回复未能完成；我没有重复生成，请先核对图片的送达情况。';
    if (state.operations.some(op=>['running','uncertain','pending','awaiting_approval','approved'].includes(op.state)))
        return '这次生图已有执行记录，结果尚未确认，已停止自动重试以免重复生成。';
    if (state.operations.length) return '这次生图工具未能完成，已保留失败记录，没有重新提交生成。';
    return '这次生图的准备回复未能完成，可用的备用链路也未完成处理，尚未提交生图请求。';
}
export async function runImageModelRecovery({dispatch, routes, guard, signal, budgetMs = Infinity, fallbackOn, stopOn = [], isCurrent = ()=>true, onAttempt = ()=>{}}) {
    const current = () => { signal?.throwIfAborted(); if (!isCurrent()) throw Object.assign(new Error('Image turn cancelled'),{name:'AbortError'}); };
    current();
    let result = await dispatch(null);
    current();
    const seen = new Set();
    const deadline = Date.now() + budgetMs;
    const retryable = () => result?.failure?.retryable && result.failure.kind !== 'policy_blocked'
        && !stopOn.includes(result.failure.kind) && (!fallbackOn || fallbackOn.includes(result.failure.kind)) && Date.now() < deadline;
    // Routes and permissions belong to the trusted caller, never to model text.
    for (const [routeIndex,route] of routes.entries()) {
        if (!retryable()) break;
        if (seen.has(route.model)) continue;
        seen.add(route.model);
        const retryPolicy = route.ai?.retry ?? {};
        for (let retry = 0; retry <= (retryPolicy.maxRetries ?? 0); retry++) {
            if (!retryable() || (retry > 0 && retryPolicy.on && !retryPolicy.on.includes(result.failure.kind))) break;
            current();
            if (retry > 0 && retryPolicy.delayMs > 0) {
                await delay(Math.min(retryPolicy.delayMs,Math.max(0,deadline-Date.now())),undefined,{signal});
                if (!retryable()) break;
            }
            const state = await guard();
            current();
            if (!state.available || state.operations.length || state.recoveryAllowed === false) return result;
            onAttempt({routeIndex,model:route.model,kind:result.failure.kind,retry});
            result = await dispatch({routeIndex,route,retry});
            current();
        }
    }
    return result;
}
