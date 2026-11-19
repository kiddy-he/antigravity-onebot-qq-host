import {AiError,validateAiConfig} from './router.js';

export const subscriptionProvider='antigravity-cli';
export const subscriptionBase='antigravity-cli://local';
const oldProvider='antigravity';

export function migrateSubscriptionRoutes(source) {
    const copy=structuredClone(source);
    const legacy=copy.providers[oldProvider];
    if(!legacy && copy.providers[subscriptionProvider]?.adapter===subscriptionProvider) return validateAiConfig(copy);
    if(!legacy || !['http://localhost:8045/v1','http://127.0.0.1:8045/v1'].includes(legacy.baseUrl?.replace(/\/$/u,'')) ||
        legacy.adapter!=='openai-chat' || copy.providers[subscriptionProvider]) {
        throw new AiError('configuration_error','Expected the original local Antigravity Manager provider');
    }
    copy.providers[subscriptionProvider]={adapter:subscriptionProvider,registryId:subscriptionProvider,
        ...(legacy.parameters?{parameters:legacy.parameters}:{})};
    delete copy.providers[oldProvider];
    for(const dep of Object.values(copy.deployments)) if(dep.provider===oldProvider) dep.provider=subscriptionProvider;
    for(const alias of copy.bindings?.nativeSearchAliases??[]) if(alias.provider===oldProvider) alias.provider=subscriptionProvider;
    const compat=copy.workflows?.compatibility;
    if(compat?.flashLiteModelLabels) compat.flashLiteModelLabels=compat.flashLiteModelLabels.map(model=>migratedModelRef(model,copy));
    return validateAiConfig(copy);
}

function migratedModelRef(value,config) {
    if(typeof value!=='string' || !value.startsWith(oldProvider+'/')) return value;
    const model=value.slice(oldProvider.length+1);
    return Object.values(config.deployments).some(d=>d.provider===subscriptionProvider && d.model===model)?
        subscriptionProvider+'/'+model:value;
}

// This legacy file is still consumed by explicit preset readers and offline tools.
export function projectSubscriptionPresets(source,config) {
    const copy=structuredClone(source);
    const migrate=entry=>{
        if(!entry?.model?.startsWith(oldProvider+'/'))return;
        const label=migratedModelRef(entry.model,config);
        if(label===entry.model)throw new AiError('configuration_error','Unmapped preset model: '+label);
        entry.model=label;
    };
    for(const preset of Object.values(copy.presets??{})){
        for(const entry of [preset.conversation,preset.textReview,...(preset.contentFallbacks??[]),...(preset.errorFallbacks??[])]) migrate(entry);
    }
    for(const entry of copy.flashLiteFallbacks??[])migrate(entry);
    return copy;
}

// Remove retired catalogue entries and secrets along with the old provider.
// Do not rewrite unrelated plugin data, credentials, or user-supplied strings.
export function projectSubscriptionHost(current,config) {
    if(!config.providers[subscriptionProvider])return;
    const old=current.models.providers[oldProvider];
    if(old && !['http://localhost:8045/v1','http://127.0.0.1:8045/v1'].includes(old.baseUrl?.replace(/\/$/u,''))) throw new AiError('configuration_error','Legacy provider address changed');
    delete current.models.providers[oldProvider];
    const models=new Map();
    for(const dep of Object.values(config.deployments).filter(x=>x.provider===subscriptionProvider)) {
        if(models.has(dep.model)) continue;
        models.set(dep.model,{id:dep.model,name:dep.model,input:dep.capabilities.includes('vision')?['text','image']:['text'],
            reasoning:dep.thinking!=='off',contextWindow:dep.limits?.contextTokens,maxTokens:dep.limits?.maxOutputTokens});
    }
    current.models.providers[subscriptionProvider]={api:'google-generative-ai',baseUrl:subscriptionBase,
        models:[...models.values()],agentRuntime:{id:subscriptionProvider}};
    const rewrite=model=>migratedModelRef(model,config);
    const retired=model=>typeof model==='string' && model.startsWith(oldProvider+'/');
    for(const agent of [current.agents?.defaults,...Object.values(current.agents?.entries??{})].filter(Boolean)){
        if(typeof agent.model==='string') agent.model=rewrite(agent.model);
        else if(agent.model){
            if(agent.model.primary) agent.model.primary=rewrite(agent.model.primary);
            if(agent.model.fallbacks) agent.model.fallbacks=agent.model.fallbacks.map(rewrite).filter(x=>!retired(x));
        }
        if(retired(typeof agent.model==='string'?agent.model:agent.model?.primary))throw new AiError('configuration_error','Legacy primary model has no native deployment');
        if(agent.models) agent.models=Object.fromEntries(Object.entries(agent.models).map(([key,value])=>[rewrite(key),value]).filter(([key])=>!retired(key)));
        if(agent.modelPolicy?.allow) agent.modelPolicy.allow=[...new Set(agent.modelPolicy.allow.map(rewrite).filter(x=>!retired(x)))];
    }
}
