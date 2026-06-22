/**
 * Sakana Fugu via Cloudflare AI Gateway custom-sakana (OpenAI Responses API).
 */

export type GatewayResponsesConfig = {
  responsesUrl: string
  upstreamAuthorization: string
  gatewayAuthToken?: string
  /** Sakana model id in request body (default fugu, not fugu-ultra). */
  responsesModel?: string
}

/** /au Fugu: reasoning eats budget; never send Workers-default 1024 alone. */
export const DEFAULT_FUGU_MAX_OUTPUT_TOKENS = 8192

const DEFAULT_ACCOUNT_ID = '99984e3c707dd2518f73dfa9da3fc887'
const DEFAULT_GATEWAY_ID = 'kami'

export function buildCustomSakanaResponsesUrl(
  accountId = DEFAULT_ACCOUNT_ID,
  gatewayId = DEFAULT_GATEWAY_ID,
): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/custom-sakana/v1/responses`
}

type ChatMessage = { role: string; content: string }

export function messagesToResponsesInput(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User'
      return `${role}:\n${m.content}`
    })
    .join('\n\n')
}

function extractStreamDeltaIncremental(payload: Record<string, unknown>): string {
  const t = payload.type
  if (typeof t === 'string') {
    if (t === 'response.output_text.delta' || t === 'response.text.delta') {
      const d = payload.delta
      if (typeof d === 'string') return d
    }
  }
  return ''
}

/** Full text from terminal events when the stream had no output_text deltas. */
function extractStreamDeltaFallback(payload: Record<string, unknown>): string {
  const t = payload.type
  if (typeof t !== 'string') return ''
  if (t === 'response.output_text.done' || t === 'response.text.done') {
    const doneText = payload.text
    if (typeof doneText === 'string' && doneText) return doneText
  }
  if (t === 'response.output_item.done') {
    const item = payload.item as Record<string, unknown> | undefined
    if (item?.type === 'message') {
      const content = item.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== 'object') continue
          const cell = c as Record<string, unknown>
          if (cell.type === 'output_text' || cell.type === 'text') {
            const text = cell.text
            if (typeof text === 'string') return text
          }
        }
      }
    }
  }
  return ''
}

function enqueueParsedSseLine(
  data: string,
  controller: TransformStreamDefaultController<string>,
  sawOutputTextDelta: { value: boolean },
) {
  if (!data || data === '[DONE]') return
  try {
    const json = JSON.parse(data) as Record<string, unknown>
    const incremental = extractStreamDeltaIncremental(json)
    if (incremental) {
      sawOutputTextDelta.value = true
      controller.enqueue(incremental)
      return
    }
    if (!sawOutputTextDelta.value) {
      const fallback = extractStreamDeltaFallback(json)
      if (fallback) controller.enqueue(fallback)
    }
  } catch {
    // ignore non-JSON lines
  }
}

/** Parse OpenAI Responses SSE into plain text chunks. */
export function openAiResponsesEventStreamToText(): TransformStream<Uint8Array, string> {
  let buffer = ''
  const sawOutputTextDelta = { value: false }
  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      buffer += new TextDecoder().decode(chunk, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        enqueueParsedSseLine(trimmed.slice(5).trim(), controller, sawOutputTextDelta)
      }
    },
    flush(controller) {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data:')) {
        enqueueParsedSseLine(trimmed.slice(5).trim(), controller, sawOutputTextDelta)
      }
    },
  })
}

export async function completeViaGatewayResponses(
  config: GatewayResponsesConfig,
  messages: ChatMessage[],
  maxOutputTokens: number | undefined,
  stream: boolean,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: config.upstreamAuthorization,
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
  }
  if (config.gatewayAuthToken) {
    headers['cf-aig-authorization'] = `Bearer ${config.gatewayAuthToken}`
  }
  const requested = maxOutputTokens ?? DEFAULT_FUGU_MAX_OUTPUT_TOKENS
  const cap = Math.max(DEFAULT_FUGU_MAX_OUTPUT_TOKENS, Math.min(16_384, requested))
  const body: Record<string, unknown> = {
    model: config.responsesModel ?? 'fugu',
    input: messagesToResponsesInput(messages),
    stream,
    max_output_tokens: cap,
  }
  const res = await fetch(config.responsesUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Fugu gateway HTTP ${res.status}: ${errText.slice(0, 500)}`)
  }
  if (!stream) {
    const json = (await res.json()) as Record<string, unknown>
    const text = extractNonStreamText(json)
    return new Response(JSON.stringify({ response: text }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (!res.body) throw new Error('Fugu gateway stream missing body')
  return res
}

function extractNonStreamText(data: Record<string, unknown>): string {
  const top = data.output_text
  if (typeof top === 'string' && top) return top
  const parts: string[] = []
  const output = data.output
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (row.type !== 'message') continue
      const content = row.content
      if (!Array.isArray(content)) continue
      for (const c of content) {
        if (!c || typeof c !== 'object') continue
        const cell = c as Record<string, unknown>
        if (cell.type === 'output_text' || cell.type === 'text') {
          const t = cell.text
          if (typeof t === 'string') parts.push(t)
        }
      }
    }
  }
  return parts.join('')
}

export async function streamViaGatewayResponses(
  config: GatewayResponsesConfig,
  messages: ChatMessage[],
  maxOutputTokens: number | undefined,
): Promise<ReadableStream<Uint8Array>> {
  const res = await completeViaGatewayResponses(config, messages, maxOutputTokens, true)
  if (!res.body) throw new Error('Fugu gateway stream missing body')
  return res.body
}