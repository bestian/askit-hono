import { CAG_MODEL_DS4_FLASH, CAG_MODEL_GEMMA } from './cagEval'
import type { CagSource } from './cag'

export const AUDREY_SKILL_DEFAULT_MODEL = CAG_MODEL_GEMMA
export const AUDREY_SKILL_GLM_52_MODEL = '@cf/zai-org/glm-5.2'
export const AUDREY_SKILL_FUGU_MODEL = 'fugu'
export const AUDREY_SKILL_NEMOTRON_ULTRA_MODEL = 'nemotron-ultra'
/**
 * DeepSeek V4 Flash via the Workers AI binding — no AI Gateway hop, so no
 * upstream provider key and no gateway run token on this path.
 */
export const AUDREY_SKILL_DS4_FLASH_MODEL = CAG_MODEL_DS4_FLASH

const ALLOWED_AUDREY_MODELS: Record<string, true> = {
  [AUDREY_SKILL_DEFAULT_MODEL]: true,
  [AUDREY_SKILL_GLM_52_MODEL]: true,
  [AUDREY_SKILL_FUGU_MODEL]: true,
  [AUDREY_SKILL_NEMOTRON_ULTRA_MODEL]: true,
  [AUDREY_SKILL_DS4_FLASH_MODEL]: true,
}

export function resolveAudreySkillModel(value: string | undefined): string {
  const model = value?.trim()
  if (!model) return AUDREY_SKILL_DEFAULT_MODEL
  return ALLOWED_AUDREY_MODELS[model] ? model : AUDREY_SKILL_DEFAULT_MODEL
}

export function buildAudreySkillAnswerInstruction(
  answerLanguage?: 'en',
): string {
  if (answerLanguage === 'en') {
    return [
      'Answer in English in Audrey Tang\'s public communication style.',
      'Do not claim to be Audrey Tang and do not speak for her.',
      'Use only the supplied transcript excerpts as factual evidence; the style guide is not evidence.',
      'For substantive claims, only cite the numbered runtime sources as [1], [2], etc.',
      'Do not output archive.tw raw URLs or archive section-id citations such as [63852758].',
      'Prefer a conversational reframe, a concrete Taiwan civic-tech example when supported, and an optimistic forward close.',
      'Stay non-partisan; critique mechanisms and tradeoffs, not people, parties, companies, or products.',
      'If the excerpts do not support the answer, say so clearly.',
    ].join(' ')
  }

  return [
    '請用唐鳳公開溝通風格作答，但不要聲稱自己是 Audrey Tang，也不要聲稱自己是唐鳳或代表她發言。',
    '預設使用繁體中文。',
    '只能使用本次提供的逐字稿段落作為事實依據；風格指南不是證據。',
    '所有實質論述只能引用本次提供的編號來源，例如 [1]、[2]。',
    '不要輸出 archive.tw 原始網址，也不要輸出像 [63852758] 這種 archive 章節編號假引註。',
    '回答節奏採對話式重新框架；若來源支持，先落在具體的台灣公民科技例子，再擴展成方法。',
    '保持非黨派；批判機制與取捨，不批判特定人物、政黨、公司或產品。',
    '如果來源不足以回答，請清楚說明。',
  ].join(' ')
}

function footnoteForSource(source: CagSource): string {
  return `[${source.label}](${source.href})`
}

const ARCHIVE_URL_PREFIX = 'https://archive.tw/'
const ARCHIVE_URL_PREFIX_PATTERN = ARCHIVE_URL_PREFIX.replace(/\./g, '\\.')
const CITATION_BODY_MAX = 64
const URL_BODY_MAX = 512

const CITATION_RE = new RegExp(`\\[([^\\][]{0,${CITATION_BODY_MAX}})\\]`, 'y')
const ARCHIVE_LINK_TAIL_RE = new RegExp(
  `\\(${ARCHIVE_URL_PREFIX_PATTERN}[^\\s)]{0,${URL_BODY_MAX}}\\)`,
  'iy',
)
const ARCHIVE_RAW_URL_RE = new RegExp(
  `${ARCHIVE_URL_PREFIX_PATTERN}[^\\s)[\\]，。,.；;！？!?]{0,${URL_BODY_MAX}}`,
  'iy',
)
const ARCHIVE_RAW_URL_GLOBAL_RE = new RegExp(ARCHIVE_RAW_URL_RE.source, 'ig')
const NUMERIC_CITATION = /^\d+(?:\s*,\s*\d+)*$/
const LINK_OPEN_RE = new RegExp(`\\[[^\\][]{0,${CITATION_BODY_MAX}}\\]\\(([^)]*)$`)
const LINK_LOOKBEHIND = CITATION_BODY_MAX + URL_BODY_MAX + ARCHIVE_URL_PREFIX.length + 4

const OPEN_BRACKET = 0x5b
const UPPER_H = 0x48
const LOWER_H = 0x68

type CitationConstruct =
  | { kind: 'citation'; end: number; body: string; link: boolean }
  | { kind: 'url'; end: number }

type CitationMatch = CitationConstruct | 'partial' | null

function appendFootnotes(
  controller: TransformStreamDefaultController<string>,
  used: Set<number>,
  sources: CagSource[],
) {
  const indexes = [...used].sort((a, b) => a - b)
  if (indexes.length === 0) return
  controller.enqueue('\n\n')
  for (const index of indexes) {
    controller.enqueue(`[^${index}]: ${footnoteForSource(sources[index - 1]!)}\n`)
  }
}

function renderCitation(
  body: string,
  link: boolean,
  used: Set<number>,
  sourceCount: number,
): string {
  const safe = body.replace(ARCHIVE_RAW_URL_GLOBAL_RE, '')
  const trimmed = safe.trim()
  if (!NUMERIC_CITATION.test(trimmed)) return link ? safe : `[${safe}]`

  const valid: number[] = []
  for (const part of trimmed.split(',')) {
    const index = Number(part.trim())
    if (Number.isInteger(index) && index >= 1 && index <= sourceCount) {
      valid.push(index)
      used.add(index)
    }
  }
  if (valid.length === 0) return ''
  return valid.map((index) => `[^${index}]`).join(', ')
}

function archiveLinkTailOpen(input: string, at: number): boolean {
  const candidate = input.slice(at).toLowerCase()
  if (input.length - at < ARCHIVE_URL_PREFIX.length) {
    return ARCHIVE_URL_PREFIX.startsWith(candidate)
  }
  if (!candidate.startsWith(ARCHIVE_URL_PREFIX)) return false
  const body = input.slice(at + ARCHIVE_URL_PREFIX.length)
  return body.length <= URL_BODY_MAX && !/[\s)]/.test(body)
}

function matchCitation(input: string, at: number): CitationMatch {
  CITATION_RE.lastIndex = at
  const matched = CITATION_RE.exec(input)
  if (!matched) {
    const bodyLength = input.length - at - 1
    return bodyLength <= CITATION_BODY_MAX && input.indexOf(']', at + 1) < 0
      ? 'partial'
      : null
  }

  const body = matched[1]!
  const end = CITATION_RE.lastIndex
  if (end === input.length) return 'partial'
  if (input.charCodeAt(end) !== 0x28) {
    return { kind: 'citation', end, body, link: false }
  }

  ARCHIVE_LINK_TAIL_RE.lastIndex = end
  if (ARCHIVE_LINK_TAIL_RE.exec(input)) {
    return { kind: 'citation', end: ARCHIVE_LINK_TAIL_RE.lastIndex, body, link: true }
  }
  return archiveLinkTailOpen(input, end + 1)
    ? 'partial'
    : { kind: 'citation', end, body, link: false }
}

function matchArchiveUrl(input: string, at: number): CitationMatch {
  ARCHIVE_RAW_URL_RE.lastIndex = at
  if (!ARCHIVE_RAW_URL_RE.exec(input)) {
    return (
      input.length - at < ARCHIVE_URL_PREFIX.length &&
      ARCHIVE_URL_PREFIX.startsWith(input.slice(at).toLowerCase())
    )
      ? 'partial'
      : null
  }
  const end = ARCHIVE_RAW_URL_RE.lastIndex
  const bodyLength = end - at - ARCHIVE_URL_PREFIX.length
  return end === input.length && bodyLength < URL_BODY_MAX
    ? 'partial'
    : { kind: 'url', end }
}

function openableSuffix(output: string): string {
  if (!output) return ''
  let start = output.length

  const citationFrom = Math.max(0, output.length - CITATION_BODY_MAX - 1)
  for (let index = citationFrom; index < start; index += 1) {
    if (output.charCodeAt(index) !== OPEN_BRACKET) continue
    if (output.indexOf(']', index + 1) >= 0) continue
    start = index
    break
  }

  const linkFrom = Math.max(0, output.length - LINK_LOOKBEHIND)
  const window = output.slice(linkFrom)
  if (window.includes('](')) {
    const link = LINK_OPEN_RE.exec(window)
    if (link && linkFrom + link.index < start) {
      const urlAt = linkFrom + link.index + link[0].length - link[1]!.length
      if (archiveLinkTailOpen(output, urlAt)) start = linkFrom + link.index
    }
  }

  const urlFrom = Math.max(0, output.length - ARCHIVE_URL_PREFIX.length + 1)
  for (let index = urlFrom; index < start; index += 1) {
    if (ARCHIVE_URL_PREFIX.startsWith(output.slice(index).toLowerCase())) {
      start = index
      break
    }
  }

  return start < output.length ? output.slice(start) : ''
}

function nextCitationOpener(input: string, from: number): number {
  for (let index = from; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    if (code === OPEN_BRACKET || code === UPPER_H || code === LOWER_H) return index
  }
  return -1
}

function resolveTruncatedCitation(
  rest: string,
  used: Set<number>,
  sourceCount: number,
): string | null {
  if (rest.charCodeAt(0) === OPEN_BRACKET) {
    const close = rest.indexOf(']')
    if (close < 0) {
      const body = rest.slice(1)
      return NUMERIC_CITATION.test(body.trim()) ? '' : null
    }

    const tail = rest.slice(close + 1)
    const truncatedUrl = tail.slice(1)
    const isLink = truncatedUrl.length >= 'https://'.length
    return (
      renderCitation(rest.slice(1, close), isLink, used, sourceCount) +
      (isLink ? '' : tail)
    )
  }
  return rest.length >= 'https://'.length ? '' : rest
}

/**
 * Shared scanner for streamed and batch answers. Failed matches advance only
 * past their opener, while deletions pull back any suffix that could become a
 * new citation or archive URL. This keeps output independent of chunk splits.
 */
function scanAudreySkillCitations(
  input: string,
  sources: CagSource[],
  used: Set<number>,
  awaitingMore: boolean,
): { text: string; rest: string } {
  let output = ''
  let buffer = input
  let cursor = 0

  function takeOpenableSuffix(): string {
    let carry = ''
    while (output) {
      const next = openableSuffix(output)
      if (!next) break
      carry = next + carry
      output = output.slice(0, output.length - next.length)
    }
    return carry
  }

  while (cursor < buffer.length) {
    const at = nextCitationOpener(buffer, cursor)
    if (at < 0) {
      output += buffer.slice(cursor)
      break
    }
    output += buffer.slice(cursor, at)
    cursor = at

    const match =
      buffer.charCodeAt(at) === OPEN_BRACKET
        ? matchCitation(buffer, at)
        : matchArchiveUrl(buffer, at)

    if (match === 'partial') {
      const rest = buffer.slice(at)
      if (awaitingMore) {
        const carry = takeOpenableSuffix()
        return { text: output, rest: carry + rest }
      }

      const resolved = resolveTruncatedCitation(rest, used, sources.length)
      if (resolved === null) {
        output += buffer[at]!
        cursor = at + 1
        continue
      }
      output += resolved
      buffer = resolved === '' ? takeOpenableSuffix() : ''
      cursor = 0
      continue
    }

    if (match === null) {
      output += buffer[at]!
      cursor = at + 1
      continue
    }

    const rendered =
      match.kind === 'citation'
        ? renderCitation(match.body, match.link, used, sources.length)
        : ''
    if (rendered === '') {
      const carry = takeOpenableSuffix()
      if (carry) {
        buffer = carry + buffer.slice(match.end)
        cursor = 0
        continue
      }
    }
    output += rendered
    cursor = match.end
  }

  return { text: output, rest: '' }
}

export function audreySkillCitationFootnotes(
  sources: CagSource[],
): TransformStream<string, string> {
  const used = new Set<number>()
  let pending = ''

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const { text, rest } = scanAudreySkillCitations(
        pending + chunk,
        sources,
        used,
        true,
      )
      pending = rest
      if (text) controller.enqueue(text)
    },
    flush(controller) {
      if (pending) {
        const { text } = scanAudreySkillCitations(pending, sources, used, false)
        pending = ''
        if (text) controller.enqueue(text)
      }
      appendFootnotes(controller, used, sources)
    },
  })
}

export function renderAudreySkillMarkdown(
  answer: string,
  sources: CagSource[],
): string {
  const used = new Set<number>()
  const { text } = scanAudreySkillCitations(answer, sources, used, false)

  const indexes = [...used].sort((a, b) => a - b)
  if (indexes.length === 0) return text.trim()

  const notes = indexes
    .map((index) => `[^${index}]: ${footnoteForSource(sources[index - 1]!)}`)
    .join('\n')
  return `${text.trim()}\n\n${notes}\n`
}
