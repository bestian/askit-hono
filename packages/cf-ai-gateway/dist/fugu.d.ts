/**
 * Sakana Fugu via Cloudflare AI Gateway custom-sakana (OpenAI Responses API).
 */
export type GatewayResponsesConfig = {
    responsesUrl: string;
    upstreamAuthorization: string;
    gatewayAuthToken?: string;
    /** Sakana model id in request body (default fugu, not fugu-ultra). */
    responsesModel?: string;
};
/** /au Fugu: reasoning eats budget; never send Workers-default 1024 alone. */
export declare const DEFAULT_FUGU_MAX_OUTPUT_TOKENS = 8192;
export declare function buildCustomSakanaResponsesUrl(accountId?: string, gatewayId?: string): string;
type ChatMessage = {
    role: string;
    content: string;
};
export declare function messagesToResponsesInput(messages: ChatMessage[]): string;
/** Parse OpenAI Responses SSE into plain text chunks. */
export declare function openAiResponsesEventStreamToText(): TransformStream<Uint8Array, string>;
export declare function completeViaGatewayResponses(config: GatewayResponsesConfig, messages: ChatMessage[], maxOutputTokens: number | undefined, stream: boolean): Promise<Response>;
export declare function streamViaGatewayResponses(config: GatewayResponsesConfig, messages: ChatMessage[], maxOutputTokens: number | undefined): Promise<ReadableStream<Uint8Array>>;
export {};
//# sourceMappingURL=fugu.d.ts.map