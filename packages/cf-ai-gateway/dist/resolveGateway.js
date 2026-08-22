import { buildBasetenChatCompletionsUrl, DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL, } from './baseten';
import { buildCustomSakanaResponsesUrl } from './fugu';
import { GATEWAY_MODEL_FUGU, GATEWAY_MODEL_NEMOTRON_ULTRA, resolveGatewayModelId, } from './modelIds';
function resolveGatewayAccount(env) {
    return env.CF_AI_GATEWAY_ACCOUNT_ID?.trim() || undefined;
}
function resolveGatewayId(env) {
    return env.CF_AI_GATEWAY_ID?.trim() || undefined;
}
function resolveFuguGateway(env) {
    const sakana = env.SAKANA_API_KEY?.trim();
    if (!sakana)
        return undefined;
    return {
        kind: 'responses',
        config: {
            responsesUrl: buildCustomSakanaResponsesUrl(resolveGatewayAccount(env), resolveGatewayId(env)),
            upstreamAuthorization: `Bearer ${sakana}`,
            gatewayAuthToken: env.CF_AIG_TOKEN?.trim() || undefined,
            responsesModel: 'fugu',
        },
    };
}
/**
 * Nemotron Ultra over the `baseten` provider. The Baseten credential lives on
 * the Cloudflare side (stored provider key), so the only secret this worker
 * needs is the AI Gateway run token; the gateway is authenticated, so without
 * it every request would 401 and `/au` is better served by the Workers AI path.
 */
function resolveNemotronGateway(env) {
    const gatewayAuthToken = env.CF_AIG_TOKEN?.trim();
    if (!gatewayAuthToken)
        return undefined;
    const chatModel = env.BASETEN_MODEL?.trim() || DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL;
    return {
        kind: 'chat',
        config: {
            chatCompletionsUrl: buildBasetenChatCompletionsUrl(resolveGatewayAccount(env), resolveGatewayId(env)),
            gatewayAuthToken,
            chatModel,
        },
    };
}
/**
 * Routes /au to Sakana Responses (needs `SAKANA_API_KEY`) or Baseten chat
 * completions (needs `CF_AIG_TOKEN`); undefined falls back to Workers AI.
 */
export function resolveAudreyAiGateway(env) {
    const model = resolveGatewayModelId(env.AUDREY_MODEL);
    if (!model)
        return undefined;
    if (model === GATEWAY_MODEL_FUGU)
        return resolveFuguGateway(env);
    if (model === GATEWAY_MODEL_NEMOTRON_ULTRA) {
        return resolveNemotronGateway(env);
    }
    return undefined;
}
