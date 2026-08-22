import type { AudreyAiGatewayConfig } from './types';
export type AudreyGatewayEnv = {
    AUDREY_MODEL?: string;
    SAKANA_API_KEY?: string;
    /** Baseten model id for chat completions (default Nemotron Ultra). */
    BASETEN_MODEL?: string;
    CF_AIG_TOKEN?: string;
    CF_AI_GATEWAY_ACCOUNT_ID?: string;
    CF_AI_GATEWAY_ID?: string;
};
/**
 * Routes /au to Sakana Responses (needs `SAKANA_API_KEY`) or Baseten chat
 * completions (needs `CF_AIG_TOKEN`); undefined falls back to Workers AI.
 */
export declare function resolveAudreyAiGateway(env: AudreyGatewayEnv): AudreyAiGatewayConfig | undefined;
//# sourceMappingURL=resolveGateway.d.ts.map