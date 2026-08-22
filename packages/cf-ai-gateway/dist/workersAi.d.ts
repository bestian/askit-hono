/**
 * Workers AI chat generation via the `AI` binding — no AI Gateway hop, so no
 * upstream provider key and no gateway run token on this path.
 *
 * Consumers that already use the binding for embeddings can reuse it for chat
 * by pointing AUDREY_MODEL at a `@cf/...` id.
 */
export type WorkersAiBinding = {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
};
type ChatMessage = {
    role: string;
    content: string;
};
/** Workers AI caps completion tokens well below the gateway models. */
export declare const DEFAULT_WORKERS_AI_MAX_COMPLETION_TOKENS = 8192;
/**
 * A `@cf/...` AUDREY_MODEL means "generate on the Workers AI binding".
 * Gateway aliases (`fugu`, `nemotron-ultra`) and unset return undefined so the
 * caller keeps its existing gateway / graceful-stub precedence.
 */
export declare function resolveWorkersAiChatModel(audreyModel: string | undefined): string | undefined;
/**
 * Mirrors askit's `buildCagAiRunInput` so grounded-citation behaviour matches
 * across workers: low temperature, reasoning disabled.
 */
export declare function buildWorkersAiChatInput(messages: ChatMessage[], maxCompletionTokens: number | undefined, stream: boolean): Record<string, unknown>;
/**
 * Streams chat completions off the binding. The returned bytes are the same
 * OpenAI-compatible SSE the gateway emits, so pipe them through
 * `openAiChatCompletionsEventStreamToText()` exactly as the gateway path does.
 */
export declare function streamViaWorkersAiChat(ai: WorkersAiBinding, model: string, messages: ChatMessage[], maxCompletionTokens?: number): Promise<ReadableStream<Uint8Array>>;
export {};
//# sourceMappingURL=workersAi.d.ts.map