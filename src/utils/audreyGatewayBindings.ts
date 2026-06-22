import {
  AUDREY_SKILL_FUGU_MODEL,
  resolveAudreySkillModel,
} from './audreySkill'
import {
  buildCustomSakanaResponsesUrl,
  type GatewayResponsesConfig,
} from './fuguGateway'

export type AudreyGatewayEnv = {
  AUDREY_MODEL?: string
  SAKANA_API_KEY?: string
  CF_AIG_TOKEN?: string
  CF_AI_GATEWAY_ACCOUNT_ID?: string
  CF_AI_GATEWAY_ID?: string
}

/** OpenAI Responses via custom-sakana when /au model is fugu and SAKANA_API_KEY is set. */
export function resolveAudreyGatewayResponses(
  env: AudreyGatewayEnv,
): GatewayResponsesConfig | undefined {
  const model = resolveAudreySkillModel(env.AUDREY_MODEL)
  if (model !== AUDREY_SKILL_FUGU_MODEL) return undefined
  const sakana = env.SAKANA_API_KEY?.trim()
  if (!sakana) return undefined
  return {
    responsesUrl: buildCustomSakanaResponsesUrl(
      env.CF_AI_GATEWAY_ACCOUNT_ID?.trim() || undefined,
      env.CF_AI_GATEWAY_ID?.trim() || undefined,
    ),
    upstreamAuthorization: `Bearer ${sakana}`,
    gatewayAuthToken: env.CF_AIG_TOKEN?.trim() || undefined,
    responsesModel: 'fugu',
  }
}