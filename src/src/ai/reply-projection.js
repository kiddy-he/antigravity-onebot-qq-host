import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { AiError } from './router.js';

const replyProjections = new AsyncLocalStorage();

/** Rebase only this turn's model selection onto the host's live, resolved config. */
export function rebaseReplyConfig(requested, published, sessionKey) {
    if (!published?.agents?.entries) return requested;
    const agentId = /^agent:([^:]+):/u.exec(sessionKey)?.[1];
    const selection = requested.agents?.entries?.[agentId];
    const entry = published.agents.entries[agentId];
    if (!entry || !selection) throw new AiError('configuration_error', 'Configured reply agent unavailable in published runtime');
    const model = selection.model;
    for (const label of [typeof model === 'string' ? model : model?.primary, ...(model?.fallbacks ?? [])].filter(Boolean)) {
        const separator = label.indexOf('/');
        const provider = published.models?.providers?.[label.slice(0, separator)];
        if (separator < 1 || !provider?.models?.some(value => value.id === label.slice(separator + 1)))
            throw new AiError('configuration_error', 'Configured reply model unavailable in published runtime');
    }
    const timeoutSec = requested.tools?.exec?.timeoutSec;
    const sameEntry = isDeepStrictEqual(entry.model, model) && isDeepStrictEqual(entry.params, selection.params);
    if (sameEntry && (timeoutSec === undefined || timeoutSec === published.tools?.exec?.timeoutSec)) return published;
    const config = structuredClone(published);
    config.agents.entries[agentId].model = structuredClone(model);
    if (selection.params === undefined) delete config.agents.entries[agentId].params;
    else config.agents.entries[agentId].params = structuredClone(selection.params);
    if (timeoutSec !== undefined) {
        config.tools ??= {}; config.tools.exec ??= {};
        config.tools.exec.timeoutSec = timeoutSec;
    }
    return config;
}

export function withReplyProjection(config, published, sessionKey, run) {
    if (config === published || !published?.agents?.entries) return run();
    const agentId = /^agent:([^:]+):/u.exec(sessionKey)?.[1];
    return replyProjections.run({ config, published, agentId }, run);
}

/** Only the exact, validated turn projection can borrow its canonical catalog. */
export function publishedConfigForReplyProjection(params) {
    const projection = replyProjections.getStore();
    if (!projection || !params.config || params.config === projection.published) return;
    if (params.agentId && params.agentId !== projection.agentId) return;
    if (!isDeepStrictEqual(params.config, projection.config)) return;
    return projection.published;
}
