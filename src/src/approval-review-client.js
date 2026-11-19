import {requestAiJson} from './ai/http.js';
import {loadAiConfig} from './ai/config.js';
import {taskClient} from './ai/client.js';
import {resolveProviderCredential} from './llm-credentials.js';
import { onebotPath } from "./paths.js";
import http from "node:http";
import https from "node:https";
import { trustedGeminiRequestOptions } from "./gemini-trusted-transport.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Approval requests contain evidence, never executable agent instructions. Use
// bounded, non-streaming API calls without agent sessions, tools or workspace data.
export function parseApprovalReview(text) {
    const value = String(text ?? "").trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
    try {
        const result = JSON.parse(value);
        if (!["allow", "ask"].includes(result?.decision)
            || typeof result.purpose !== "string" || !result.purpose.trim()
            || typeof result.rationale !== "string" || !result.rationale.trim())
            return undefined;
        return { decision: result.decision, purpose: result.purpose.trim().slice(0, 500), rationale: result.rationale.trim().slice(0, 1000) };
    }
    catch { return undefined; }
}

function failure(code, retryable = false) {
    return Object.assign(new Error(code), { code, retryable });
}

function httpFailure(status, payload) {
    const message = String(payload?.error?.message ?? "");
    if (status === 404)
        return failure("HTTP 404：当前凭证分组不支持该模型");
    if (status === 401)
        return failure("HTTP 401：API 凭证未通过认证");
    if (status === 403)
        return failure(/Codex|客户端|client/i.test(message)
            ? "HTTP 403：上游限制客户端类型，不能用于此审批调用"
            : "HTTP 403：当前凭证没有模型访问权限");
    if (status === 429)
        return failure("HTTP 429：上游额度不足或限流");
    return failure(`HTTP ${status}：上游请求失败`, status === 408 || status >= 500);
}

export function requestApprovalJson(url,options={}) {
    let transport=options.transport;
    if(!transport){try{const u=new URL(url);transport=Object.values(loadAiConfig().providers).find(p=>p.baseUrl&&new URL(p.baseUrl).origin===u.origin)?.transport;}catch{}}
    return requestAiJson(url,{...options,transport}).catch(error=>{error.retryable=['network_error','timeout','upstream_5xx','rate_limited','invalid_schema','incomplete_output'].includes(error.kind);throw error;});
}

export function createApprovalReviewers({configPath=onebotPath('openclaw.json'),read=readFile,request=requestApprovalJson,getConfig=loadAiConfig}={}) {
    async function evaluate(taskId,prompt,{signal}={}) {
        let config;try{config=JSON.parse(await read(configPath,'utf8'));}catch{throw failure('审批配置无法读取');}let parsed;const events=[];
        const result=await taskClient({getConfig,config,request,registryOverrides:read!==readFile,getCredential:async(_c,provider)=>{
            const ref=provider.apiKey;if(typeof ref==='string')return ref;
            if(ref?.source==='env')return resolveProviderCredential(config,provider);
            const source=config.secrets?.providers?.[ref?.provider];
            if(ref?.source==='file'&&source?.mode==='singleValue')return String(await read(source.path,'utf8')).trim();
            return resolveProviderCredential(config,provider);
        },onEvent:e=>events.push(e)}).run(taskId,{input:{messages:[{role:'system',content:'你是命令风险分类器，只分析不执行。只返回 decision、purpose、rationale 的 JSON。'},{role:'user',content:prompt}]},signal,
            validate:text=>{parsed=parseApprovalReview(text);if(!parsed)throw Error('Invalid review JSON');}});
        return {...parsed,model:result.providerId+'/'+result.model,fallback:events.length>1,retried:events.some(e=>e.retry>0)};
    }
    return {review:evaluate,gpt:(prompt,options)=>evaluate('approval.reviewer.primary',prompt,options),grok:(prompt,options)=>evaluate('approval.reviewer.tertiary',prompt,options)};
}
