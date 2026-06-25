import type { GatewayChatCompletionsConfig } from './basetenGateway'
import type { GatewayResponsesConfig } from './fuguGateway'

/** External LLM for /au when Workers AI binding is bypassed. */
export type AudreyAiGatewayConfig =
  | { kind: 'responses'; config: GatewayResponsesConfig }
  | { kind: 'chat'; config: GatewayChatCompletionsConfig }