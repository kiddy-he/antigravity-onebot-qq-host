import { AiError } from './router.js';
import { rebaseReplyConfig, withReplyProjection } from './reply-projection.js';

/** Keep the host's live provider/catalog generation and apply only turn-local selection. */
export async function dispatchConfiguredReply(params, {
    dispatch,
    loadRuntime = async () => {
        const [reply, config] = await Promise.all([
            import('openclaw/plugin-sdk/reply-runtime'),
            import('openclaw/plugin-sdk/config-runtime'),
        ]);
        return { ...reply, getRuntimeConfig: config.getRuntimeConfig };
    },
} = {}) {
    if (!params.cfg || !params.ctx?.SessionKey || typeof dispatch !== 'function')
        throw new AiError('configuration_error', 'Configured reply requires config, session and dispatcher');
    if(process.env.ONEBOT_STANDALONE==='1') return dispatch(params);
    const {onebotTask, ...hostParams} = params;
    const { getReplyFromConfig, getRuntimeConfig } = await loadRuntime();
    if (typeof getReplyFromConfig !== 'function')
        throw new AiError('configuration_error', 'Explicit reply configuration override unavailable');
    return dispatch({
        ...hostParams,
        replyResolver: (ctx, options, published) => {
            const canonical = typeof getRuntimeConfig === 'function' ? getRuntimeConfig() : published;
            const config = rebaseReplyConfig(params.cfg, canonical, ctx.SessionKey);
            return withReplyProjection(config, canonical, ctx.SessionKey,
                () => getReplyFromConfig(ctx, options, config));
        },
    });
}
