export const GATEWAY_MODEL_FUGU = 'fugu'
export const GATEWAY_MODEL_NEMOTRON_ULTRA = 'nemotron-ultra'

/** Only explicit gateway model ids; unset/gemma/glm/unknown → undefined (Workers AI path). */
export function resolveGatewayModelId(
  audreyModel: string | undefined,
): string | undefined {
  const m = audreyModel?.trim()
  if (m === GATEWAY_MODEL_FUGU || m === GATEWAY_MODEL_NEMOTRON_ULTRA) return m
  return undefined
}