/**
 * Baseten models via Cloudflare AI Gateway (OpenAI-compatible chat completions).
 * @see https://developers.cloudflare.com/ai-gateway/usage/providers/baseten/
 */
export type GatewayChatCompletionsConfig = {
    chatCompletionsUrl: string;
    /**
     * Upstream provider credential (e.g. `Api-Key <baseten-key>`). Omit to let the
     * gateway inject the provider key stored on the Cloudflare side. Sending this
     * header overrides the stored key, so a stale value fails the upstream call.
     */
    upstreamAuthorization?: string;
    gatewayAuthToken?: string;
    /** Baseten model id in request body. */
    chatModel: string;
};
export declare const DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL = "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B";
/** /au Nemotron: allow longer answers than Workers-default 1024. */
export declare const DEFAULT_NEMOTRON_MAX_COMPLETION_TOKENS = 8192;
type ChatMessage = {
    role: string;
    content: string;
};
export declare function buildBasetenChatCompletionsUrl(accountId?: string, gatewayId?: string): string;
/** Parse OpenAI chat-completions SSE into plain text chunks. */
export declare function openAiChatCompletionsEventStreamToText(): TransformStream<Uint8Array, string>;
export declare function completeViaGatewayChatCompletions(config: GatewayChatCompletionsConfig, messages: ChatMessage[], maxCompletionTokens: number | undefined, stream: boolean): Promise<Response>;
export declare function streamViaGatewayChatCompletions(config: GatewayChatCompletionsConfig, messages: ChatMessage[], maxCompletionTokens: number | undefined): Promise<ReadableStream<Uint8Array>>;
export declare function streamViaDirectBasetenChatCompletions(apiKey: string, model: string, messages: ChatMessage[], maxCompletionTokens: number | undefined): Promise<ReadableStream<Uint8Array>>;
export {};
//# sourceMappingURL=baseten.d.ts.map