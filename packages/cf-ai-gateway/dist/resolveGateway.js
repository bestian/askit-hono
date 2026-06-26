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
function resolveNemotronGateway(env) {
    const baseten = env.BASETEN_API_KEY?.trim();
    if (!baseten)
        return undefined;
    const chatModel = env.BASETEN_MODEL?.trim() || DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL;
    return {
        kind: 'chat',
        config: {
            chatCompletionsUrl: buildBasetenChatCompletionsUrl(resolveGatewayAccount(env), resolveGatewayId(env)),
            upstreamAuthorization: `Api-Key ${baseten}`,
            gatewayAuthToken: env.CF_AIG_TOKEN?.trim() || undefined,
            chatModel,
        },
    };
}
/** Routes /au to Sakana Responses or Baseten chat completions when keys are set. */
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
