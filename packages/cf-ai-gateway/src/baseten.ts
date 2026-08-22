/**
 * Baseten models via Cloudflare AI Gateway (OpenAI-compatible chat completions).
 * @see https://developers.cloudflare.com/ai-gateway/usage/providers/baseten/
 */

import {
  DEFAULT_CF_AI_GATEWAY_ACCOUNT_ID,
  DEFAULT_CF_AI_GATEWAY_ID,
} from './defaults'

export type GatewayChatCompletionsConfig = {
  chatCompletionsUrl: string
  /**
   * Upstream provider credential (e.g. `Api-Key <baseten-key>`). Omit to let the
   * gateway inject the provider key stored on the Cloudflare side. Sending this
   * header overrides the stored key, so a stale value fails the upstream call.
   */
  upstreamAuthorization?: string
  gatewayAuthToken?: string
  /** Baseten model id in request body. */
  chatModel: string
}

export const DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL =
  'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B'

/** /au Nemotron: allow longer answers than Workers-default 1024. */
export const DEFAULT_NEMOTRON_MAX_COMPLETION_TOKENS = 8192

type ChatMessage = { role: string; content: string }

export function buildBasetenChatCompletionsUrl(
  accountId = DEFAULT_CF_AI_GATEWAY_ACCOUNT_ID,
  gatewayId = DEFAULT_CF_AI_GATEWAY_ID,
): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/baseten/v1/chat/completions`
}

function gatewayHeaders(
  config: GatewayChatCompletionsConfig,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  }
  if (config.upstreamAuthorization) {
    headers.Authorization = config.upstreamAuthorization
  }
  if (config.gatewayAuthToken) {
    headers['cf-aig-authorization'] = `Bearer ${config.gatewayAuthToken}`
  }
  return headers
}

function clampMaxTokens(maxCompletionTokens: number | undefined): number {
  const requested = maxCompletionTokens ?? DEFAULT_NEMOTRON_MAX_COMPLETION_TOKENS
  return Math.max(
    DEFAULT_NEMOTRON_MAX_COMPLETION_TOKENS,
    Math.min(16_384, requested),
  )
}

function extractChatCompletionText(data: Record<string, unknown>): string {
  const choices = data.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first = choices[0]
  if (!first || typeof first !== 'object') return ''
  const row = first as Record<string, unknown>
  const message = row.message
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') return content
  }
  const delta = row.delta
  if (delta && typeof delta === 'object') {
    const content = (delta as Record<string, unknown>).content
    if (typeof content === 'string') return content
  }
  const text = row.text
  if (typeof text === 'string') return text
  return ''
}

function extractChatStreamDelta(data: string): string {
  if (data === '[DONE]') return ''
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    return extractChatCompletionText(parsed)
  } catch {
    return ''
  }
}

/** Parse OpenAI chat-completions SSE into plain text chunks. */
export function openAiChatCompletionsEventStreamToText(): TransformStream<
  Uint8Array,
  string
> {
  const decoder = new TextDecoder()
  let buffer = ''

  function processLine(
    line: string,
    controller: TransformStreamDefaultController<string>,
  ) {
    const trimmed = line.trimEnd()
    if (trimmed === '') return
    if (trimmed.startsWith('data:')) {
      const text = extractChatStreamDelta(trimmed.slice('data:'.length).trim())
      if (text) controller.enqueue(text)
      return
    }
    if (/^(event|id|retry):/.test(trimmed)) return
  }

  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) processLine(line, controller)
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) processLine(buffer, controller)
    },
  })
}

export async function completeViaGatewayChatCompletions(
  config: GatewayChatCompletionsConfig,
  messages: ChatMessage[],
  maxCompletionTokens: number | undefined,
  stream: boolean,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: config.chatModel,
    messages,
    stream,
    max_tokens: clampMaxTokens(maxCompletionTokens),
  }
  const res = await fetch(config.chatCompletionsUrl, {
    method: 'POST',
    headers: gatewayHeaders(config, stream),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(
      `Baseten gateway HTTP ${res.status}: ${errText.slice(0, 500)}`,
    )
  }
  if (!stream) {
    const json = (await res.json()) as Record<string, unknown>
    const text = extractChatCompletionText(json)
    return new Response(JSON.stringify({ response: text }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!res.body) throw new Error('Baseten gateway stream missing body')
  return res
}

export async function streamViaGatewayChatCompletions(
  config: GatewayChatCompletionsConfig,
  messages: ChatMessage[],
  maxCompletionTokens: number | undefined,
): Promise<ReadableStream<Uint8Array>> {
  const res = await completeViaGatewayChatCompletions(
    config,
    messages,
    maxCompletionTokens,
    true,
  )
  if (!res.body) throw new Error('Baseten gateway stream missing body')
  return res.body
}
export async function streamViaDirectBasetenChatCompletions(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxCompletionTokens: number | undefined,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch('https://inference.baseten.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: clampMaxTokens(maxCompletionTokens),
      stream: true,
    }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(
      `Direct Baseten HTTP ${res.status}: ${errText.slice(0, 500)}`,
    )
  }
  if (!res.body) throw new Error('Direct Baseten stream missing body')
  return res.body
}

