import {
  buildArchiveTwSectionHref,
  findClosestMatchingSections,
  htmlToPlainText,
  type AskSearchResult,
} from './search'

type WorkersAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>
}

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

export type CagOptions = {
  model?: string
  topK?: number
  maxCompletionTokens?: number
}

export const DEFAULT_CAG_MODEL = '@cf/moonshotai/kimi-k2.6'
const DEFAULT_TOP_K = 6
const MAX_TOP_K = 12
const DEFAULT_MAX_COMPLETION_TOKENS = 900
const MAX_CONTEXT_SECTION_CHARS = 2_200

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function sourceLabel(hit: AskSearchResult): string {
  const speaker = hit.name?.trim()
  return speaker ? `${hit.display_name} — ${speaker}` : hit.display_name
}

function sourceHref(hit: AskSearchResult): string {
  return buildArchiveTwSectionHref(
    hit.filename,
    hit.section_id,
    hit.nest_filename,
  )
}

function truncateContextText(value: string): string {
  if (value.length <= MAX_CONTEXT_SECTION_CHARS) return value
  return `${value.slice(0, MAX_CONTEXT_SECTION_CHARS).trimEnd()}\n[... excerpt trimmed ...]`
}

function footnoteForHit(hit: AskSearchResult): string {
  return `[${sourceLabel(hit)}](${sourceHref(hit)})`
}

function buildCagMessages(question: string, hits: AskSearchResult[]): ChatMessage[] {
  const lore = hits
    .map((hit, index) => {
      const n = index + 1
      const content = truncateContextText(htmlToPlainText(hit.content))
      return [
        `[${n}] ${sourceLabel(hit)}`,
        `url: ${sourceHref(hit)}`,
        '```text',
        content,
        '```',
      ].join('\n')
    })
    .join('\n\n')

  return [
    {
      role: 'system',
      content: [
        'You answer questions using only the cited SayIt transcript excerpts supplied by the user.',
        'Do not invent details outside the excerpts.',
        'When stating a concrete fact, cite the source number as [1], [2], etc.',
        'If the excerpts do not support an answer, say so clearly.',
        'Use Traditional Chinese when the user asks in Chinese or includes #zh-tw.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        '<lore>',
        lore,
        '</lore>',
        '',
        `Question: ${question}`,
        '',
        'Answer concisely. Prefer exact wording from the excerpts where useful.',
      ].join('\n'),
    },
  ]
}

function aiResultToStream(result: unknown): ReadableStream<Uint8Array> {
  if (result instanceof ReadableStream) {
    return result as ReadableStream<Uint8Array>
  }
  if (result instanceof Response && result.body) {
    return result.body
  }

  let text = ''
  if (typeof result === 'string') {
    text = result
  } else if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    text =
      typeof obj.response === 'string'
        ? obj.response
        : typeof obj.result === 'string'
          ? obj.result
          : JSON.stringify(result)
  } else {
    text = String(result ?? '')
  }
  return new Response(text).body!
}

function extractStreamingText(data: string): string {
  if (data === '[DONE]') return ''
  try {
    const parsed = JSON.parse(data) as unknown
    if (typeof parsed === 'string') return parsed
    if (!parsed || typeof parsed !== 'object') return ''

    const obj = parsed as Record<string, unknown>
    if (typeof obj.response === 'string') return obj.response
    if (typeof obj.output_text === 'string') return obj.output_text
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.result === 'string') return obj.result

    const result = obj.result
    if (result && typeof result === 'object') {
      const resultObj = result as Record<string, unknown>
      if (typeof resultObj.response === 'string') return resultObj.response
      if (typeof resultObj.text === 'string') return resultObj.text
    }

    const choices = obj.choices
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0] as Record<string, unknown>
      if (typeof choice.text === 'string') return choice.text
      const delta = choice.delta as Record<string, unknown> | undefined
      if (delta && typeof delta.content === 'string') return delta.content
      const message = choice.message as Record<string, unknown> | undefined
      if (message && typeof message.content === 'string') return message.content
    }
  } catch {
    return data
  }
  return ''
}

function workersAiEventStreamToText(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let sawSse = false

  function processLine(line: string, controller: TransformStreamDefaultController<string>) {
    const trimmed = line.trimEnd()
    if (trimmed === '') return
    if (trimmed.startsWith('data:')) {
      sawSse = true
      const text = extractStreamingText(trimmed.slice('data:'.length).trim())
      if (text) controller.enqueue(text)
      return
    }
    if (/^(event|id|retry):/.test(trimmed)) return
    if (!sawSse) controller.enqueue(`${line}\n`)
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
      if (buffer) {
        if (sawSse) {
          processLine(buffer, controller)
        } else {
          controller.enqueue(buffer)
        }
      }
    },
  })
}

function markdownCitationFootnotes(footnotes: string[]): TransformStream<string, string> {
  const used = new Set<number>()
  let state: 'text' | 'citation' = 'text'
  let digits = ''

  function emitCitation(controller: TransformStreamDefaultController<string>, raw: string) {
    const index = Number(raw)
    if (Number.isInteger(index) && index >= 1 && index <= footnotes.length) {
      used.add(index)
      controller.enqueue(`[^${index}]`)
    } else {
      controller.enqueue(`[${raw}]`)
    }
  }

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      for (const char of chunk) {
        if (state === 'text') {
          if (char === '[') {
            state = 'citation'
            digits = ''
          } else {
            controller.enqueue(char)
          }
          continue
        }

        if (/\d/.test(char) && digits.length < 9) {
          digits += char
          continue
        }
        if (char === ']' && digits !== '') {
          emitCitation(controller, digits)
          state = 'text'
          digits = ''
          continue
        }
        controller.enqueue(`[${digits}${char}`)
        state = 'text'
        digits = ''
      }
    },
    flush(controller) {
      if (state === 'citation') {
        controller.enqueue(`[${digits}`)
      }
      const indexes = [...used].sort((a, b) => a - b)
      if (indexes.length > 0) {
        controller.enqueue('\n\n')
        for (const index of indexes) {
          controller.enqueue(`[^${index}]: ${footnotes[index - 1]}\n`)
        }
      }
    },
  })
}

export async function streamCagAnswer(
  ai: WorkersAiBinding,
  bucket: R2Bucket,
  question: string,
  options?: CagOptions,
): Promise<Response> {
  const topK = clampInteger(options?.topK ?? DEFAULT_TOP_K, 1, MAX_TOP_K)
  const hits = await findClosestMatchingSections(bucket, question, { limit: topK })
  if (hits.length === 0) {
    return new Response('找不到符合條件的逐字稿段落', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    })
  }

  const model = options?.model || DEFAULT_CAG_MODEL
  const messages = buildCagMessages(question, hits)
  const stream = await ai.run(model, {
    messages,
    stream: true,
    max_completion_tokens: clampInteger(
      options?.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
      1,
      4_096,
    ),
    temperature: 0.2,
  })

  const body = aiResultToStream(stream)
    .pipeThrough(workersAiEventStreamToText())
    .pipeThrough(markdownCitationFootnotes(hits.map(footnoteForHit)))
    .pipeThrough(new TextEncoderStream())

  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}
