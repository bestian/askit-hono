import {
  AUDREY_SKILL_FUGU_MODEL,
  AUDREY_SKILL_NEMOTRON_ULTRA_MODEL,
  resolveAudreySkillModel,
} from './audreySkill'
import {
  buildBasetenChatCompletionsUrl,
  DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL,
  type GatewayChatCompletionsConfig,
} from './basetenGateway'
import type { AudreyAiGatewayConfig } from './audreyAiGateway'
import {
  buildCustomSakanaResponsesUrl,
  type GatewayResponsesConfig,
} from './fuguGateway'

export type AudreyGatewayEnv = {
  AUDREY_MODEL?: string
  SAKANA_API_KEY?: string
  BASETEN_API_KEY?: string
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

function resolveNemotronGateway(
  env: AudreyGatewayEnv,
): { kind: 'chat'; config: GatewayChatCompletionsConfig } | undefined {
  const baseten = env.BASETEN_API_KEY?.trim()
  if (!baseten) return undefined
  const chatModel =
    env.BASETEN_MODEL?.trim() || DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL
  return {
    kind: 'chat',
    config: {
      chatCompletionsUrl: buildBasetenChatCompletionsUrl(
        resolveGatewayAccount(env),
        resolveGatewayId(env),
      ),
      upstreamAuthorization: `Api-Key ${baseten}`,
      gatewayAuthToken: env.CF_AIG_TOKEN?.trim() || undefined,
      chatModel,
    },
  }
}

/** Routes /au to Sakana Responses or Baseten chat completions when keys are set. */
export function resolveAudreyAiGateway(
  env: AudreyGatewayEnv,
): AudreyAiGatewayConfig | undefined {
  const model = resolveAudreySkillModel(env.AUDREY_MODEL)
  if (model === AUDREY_SKILL_FUGU_MODEL) return resolveFuguGateway(env)
  if (model === AUDREY_SKILL_NEMOTRON_ULTRA_MODEL) {
    return resolveNemotronGateway(env)
  }
  return undefined
}