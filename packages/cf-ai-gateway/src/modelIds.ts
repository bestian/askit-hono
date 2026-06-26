export const GATEWAY_MODEL_FUGU = 'fugu'
export const GATEWAY_MODEL_NEMOTRON_ULTRA = 'nemotron-ultra'

export function normalizeGatewayModel(
  audreyModel: string | undefined,
  defaultModel: string,
): string {
  const m = audreyModel?.trim()
  if (m === GATEWAY_MODEL_FUGU || m === GATEWAY_MODEL_NEMOTRON_ULTRA) return m
  return defaultModel
}