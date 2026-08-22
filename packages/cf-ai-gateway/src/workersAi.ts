/**
 * Workers AI chat generation via the `AI` binding — no AI Gateway hop, so no
 * upstream provider key and no gateway run token on this path.
 *
 * Consumers that already use the binding for embeddings can reuse it for chat
 * by pointing AUDREY_MODEL at a `@cf/...` id.
 */

export type WorkersAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>
}

type ChatMessage = { role: string; content: string }

/** Workers AI caps completion tokens well below the gateway models. */
export const DEFAULT_WORKERS_AI_MAX_COMPLETION_TOKENS = 8_192

/**
 * A `@cf/...` AUDREY_MODEL means "generate on the Workers AI binding".
 * Gateway aliases (`fugu`, `nemotron-ultra`) and unset return undefined so the
 * caller keeps its existing gateway / graceful-stub precedence.
 */
export function resolveWorkersAiChatModel(
  audreyModel: string | undefined,
): string | undefined {
  const model = audreyModel?.trim()
  if (!model || !model.startsWith('@cf/')) return undefined
  return model
}

function clampMaxTokens(maxCompletionTokens: number | undefined): number {
  const requested =
    maxCompletionTokens ?? DEFAULT_WORKERS_AI_MAX_COMPLETION_TOKENS
  return Math.max(1, Math.min(8_192, Math.trunc(requested)))
}

/**
 * Mirrors askit's `buildCagAiRunInput` so grounded-citation behaviour matches
 * across workers: low temperature, reasoning disabled.
 */
export function buildWorkersAiChatInput(
  messages: ChatMessage[],
  maxCompletionTokens: number | undefined,
  stream: boolean,
): Record<string, unknown> {
  return {
    messages,
    stream,
    max_completion_tokens: clampMaxTokens(maxCompletionTokens),
    temperature: 0.2,
    reasoning_effort: 'none',
    chat_template_kwargs: { thinking: false, enable_thinking: false },
  }
}

/**
 * Streams chat completions off the binding. The returned bytes are the same
 * OpenAI-compatible SSE the gateway emits, so pipe them through
 * `openAiChatCompletionsEventStreamToText()` exactly as the gateway path does.
 */
export async function streamViaWorkersAiChat(
  ai: WorkersAiBinding,
  model: string,
  messages: ChatMessage[],
  maxCompletionTokens?: number,
): Promise<ReadableStream<Uint8Array>> {
  const result = await ai.run(
    model,
    buildWorkersAiChatInput(messages, maxCompletionTokens, true),
  )
  if (!result || typeof (result as ReadableStream).getReader !== 'function') {
    throw new Error(`Workers AI ${model} did not return a stream`)
  }
  return result as ReadableStream<Uint8Array>
}
