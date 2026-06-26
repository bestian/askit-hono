import type { GatewayChatCompletionsConfig } from './baseten'
import type { GatewayResponsesConfig } from './fugu'

/** External LLM for /au when Workers AI binding is bypassed. */
export type CfAiGatewayConfig =
  | { kind: 'responses'; config: GatewayResponsesConfig }
  | { kind: 'chat'; config: GatewayChatCompletionsConfig }

export type AudreyAiGatewayConfig = CfAiGatewayConfig