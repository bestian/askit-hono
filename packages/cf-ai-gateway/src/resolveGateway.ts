import {
  buildBasetenChatCompletionsUrl,
  DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL,
  type GatewayChatCompletionsConfig,
} from './baseten'
import { buildCustomSakanaResponsesUrl, type GatewayResponsesConfig } from './fugu'
import {
  GATEWAY_MODEL_FUGU,
  GATEWAY_MODEL_NEMOTRON_ULTRA,
  resolveGatewayModelId,
} from './modelIds'
import type { AudreyAiGatewayConfig } from './types'

export type AudreyGatewayEnv = {
  AUDREY_MODEL?: string
  SAKANA_API_KEY?: string
  /** Baseten model id for chat completions (default Nemotron Ultra). */
  BASETEN_MODEL?: string
  CF_AIG_TOKEN?: string
  CF_AI_GATEWAY_ACCOUNT_ID?: string
  CF_AI_GATEWAY_ID?: string
}

function resolveGatewayAccount(env: AudreyGatewayEnv): string | undefined {
  return env.CF_AI_GATEWAY_ACCOUNT_ID?.trim() || undefined
}

function resolveGatewayId(env: AudreyGatewayEnv): string | undefined {
  return env.CF_AI_GATEWAY_ID?.trim() || undefined
}

function resolveFuguGateway(
  env: AudreyGatewayEnv,
): { kind: 'responses'; config: GatewayResponsesConfig } | undefined {
  const sakana = env.SAKANA_API_KEY?.trim()
  if (!sakana) return undefined
  return {
    kind: 'responses',
    config: {
      responsesUrl: buildCustomSakanaResponsesUrl(
        resolveGatewayAccount(env),
        resolveGatewayId(env),
      ),
      upstreamAuthorization: `Bearer ${sakana}`,
      gatewayAuthToken: env.CF_AIG_TOKEN?.trim() || undefined,
      responsesModel: 'fugu',
    },
  }
}

/**
 * Nemotron Ultra over the `baseten` provider. The Baseten credential lives on
 * the Cloudflare side (stored provider key), so the only secret this worker
 * needs is the AI Gateway run token; the gateway is authenticated, so without
 * it every request would 401 and `/au` is better served by the Workers AI path.
 */
function resolveNemotronGateway(
  env: AudreyGatewayEnv,
): { kind: 'chat'; config: GatewayChatCompletionsConfig } | undefined {
  const gatewayAuthToken = env.CF_AIG_TOKEN?.trim()
  if (!gatewayAuthToken) return undefined
  const chatModel =
    env.BASETEN_MODEL?.trim() || DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL
  return {
    kind: 'chat',
    config: {
      chatCompletionsUrl: buildBasetenChatCompletionsUrl(
        resolveGatewayAccount(env),
        resolveGatewayId(env),
      ),
      gatewayAuthToken,
      chatModel,
    },
  }
}

/**
 * Routes /au to Sakana Responses (needs `SAKANA_API_KEY`) or Baseten chat
 * completions (needs `CF_AIG_TOKEN`); undefined falls back to Workers AI.
 */
export function resolveAudreyAiGateway(
  env: AudreyGatewayEnv,
): AudreyAiGatewayConfig | undefined {
  const model = resolveGatewayModelId(env.AUDREY_MODEL)
  if (!model) return undefined
  if (model === GATEWAY_MODEL_FUGU) return resolveFuguGateway(env)
  if (model === GATEWAY_MODEL_NEMOTRON_ULTRA) {
    return resolveNemotronGateway(env)
  }
  return undefined
}