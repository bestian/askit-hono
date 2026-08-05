import { CAG_MODEL_GEMMA } from './cagEval'
import type { CagSource } from './cag'

export const AUDREY_SKILL_DEFAULT_MODEL = CAG_MODEL_GEMMA
export const AUDREY_SKILL_GLM_52_MODEL = '@cf/zai-org/glm-5.2'
export const AUDREY_SKILL_FUGU_MODEL = 'fugu'
export const AUDREY_SKILL_NEMOTRON_ULTRA_MODEL = 'nemotron-ultra'

const ALLOWED_AUDREY_MODELS: Record<string, true> = {
  [AUDREY_SKILL_DEFAULT_MODEL]: true,
  [AUDREY_SKILL_GLM_52_MODEL]: true,
  [AUDREY_SKILL_FUGU_MODEL]: true,
  [AUDREY_SKILL_NEMOTRON_ULTRA_MODEL]: true,
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

const ARCHIVE_MARKDOWN_LINK = /\[(\d+)\]\(https:\/\/archive\.tw\/[^)\s]+#s\d+\)/g
const ARCHIVE_MARKDOWN_LINK_TEXT = /\[([^\]\d][^\]]*)\]\(https:\/\/archive\.tw\/[^)\s]+#s\d+\)/g
const ARCHIVE_RAW_URL = /https:\/\/archive\.tw\/[^\s)]+#s\d+/g
const CITATION_PATTERN = /\[(\d{1,9})\]/g

const ARCHIVE_URL_PREFIX = 'https://archive.tw/'
const ARCHIVE_URL_DELIMITER = /[\s)，。,.；;！？!?\]]/u

type StrictCitationState = 'text' | 'citation' | 'urlCandidate' | 'archiveUrl'

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

function emitStrictCitation(
  controller: TransformStreamDefaultController<string>,
  raw: string,
  used: Set<number>,
  sourceCount: number,
): boolean {
  const trimmed = raw.trim()
  if (!/^\d+(?:\s*,\s*\d+)*$/.test(trimmed)) {
    controller.enqueue(`[${raw}]`)
    return false
  }

  const valid: number[] = []
  for (const part of trimmed.split(',')) {
    const index = Number(part.trim())
    if (Number.isInteger(index) && index >= 1 && index <= sourceCount) {
      valid.push(index)
      used.add(index)
    }
  }
  if (valid.length === 0) return true
  controller.enqueue(valid.map((index) => `[^${index}]`).join(', '))
  return false
}

export function audreySkillCitationFootnotes(
  sources: CagSource[],
): TransformStream<string, string> {
  const used = new Set<number>()
  let state: StrictCitationState = 'text'
  let citation = ''
  let urlCandidate = ''
  let droppedNumericCitation = false
  let suppressArchiveLinkCloseParen = false

  function emitTextChar(
    controller: TransformStreamDefaultController<string>,
    char: string,
  ) {
    if (char === '[') {
      state = 'citation'
      citation = ''
      return
    }
    if (char === 'h') {
      state = 'urlCandidate'
      urlCandidate = 'h'
      return
    }
    if (droppedNumericCitation && char === '(') {
      suppressArchiveLinkCloseParen = true
      droppedNumericCitation = false
      return
    }
    droppedNumericCitation = false
    controller.enqueue(char)
  }

  function emitUrlCandidate(
    controller: TransformStreamDefaultController<string>,
    char: string,
  ) {
    const next = urlCandidate + char
    if (ARCHIVE_URL_PREFIX.startsWith(next)) {
      urlCandidate = next
      if (next === ARCHIVE_URL_PREFIX) {
        state = 'archiveUrl'
        urlCandidate = ''
      }
      return
    }
    controller.enqueue(urlCandidate)
    state = 'text'
    urlCandidate = ''
    droppedNumericCitation = false
    emitTextChar(controller, char)
  }

  function consumeArchiveUrl(
    controller: TransformStreamDefaultController<string>,
    char: string,
  ) {
    if (!ARCHIVE_URL_DELIMITER.test(char)) return
    state = 'text'
    if (char === ')' && suppressArchiveLinkCloseParen) {
      suppressArchiveLinkCloseParen = false
      return
    }
    suppressArchiveLinkCloseParen = false
    controller.enqueue(char)
  }

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      for (const char of chunk) {
        if (state === 'text') {
          emitTextChar(controller, char)
          continue
        }
        if (state === 'citation') {
          if (char === ']') {
            droppedNumericCitation = emitStrictCitation(
              controller,
              citation,
              used,
              sources.length,
            )
            citation = ''
            state = 'text'
            continue
          }
          if (citation.length > 64) {
            controller.enqueue(`[${citation}${char}`)
            citation = ''
            state = 'text'
            droppedNumericCitation = false
            continue
          }
          citation += char
          continue
        }
        if (state === 'urlCandidate') {
          emitUrlCandidate(controller, char)
          continue
        }
        consumeArchiveUrl(controller, char)
      }
    },
    flush(controller) {
      if (state === 'citation') {
        if (!/^\d+(?:\s*,\s*\d+)*$/.test(citation.trim())) {
          controller.enqueue(`[${citation}`)
        }
      } else if (state === 'urlCandidate') {
        if (
          urlCandidate.length < 'https://'.length ||
          !ARCHIVE_URL_PREFIX.startsWith(urlCandidate)
        ) {
          controller.enqueue(urlCandidate)
        }
      }
      appendFootnotes(controller, used, sources)
    },
  })
}

function stripModelArchiveCitations(text: string): string {
  return text
    .replace(ARCHIVE_MARKDOWN_LINK, '')
    .replace(ARCHIVE_MARKDOWN_LINK_TEXT, '$1')
    .replace(ARCHIVE_RAW_URL, '')
}

export function renderAudreySkillMarkdown(
  answer: string,
  sources: CagSource[],
): string {
  const used = new Set<number>()
  const cleaned = stripModelArchiveCitations(answer).replace(
    CITATION_PATTERN,
    (_match, raw: string) => {
      const index = Number(raw)
      if (Number.isInteger(index) && index >= 1 && index <= sources.length) {
        used.add(index)
        return `[^${index}]`
      }
      return ''
    },
  )

  const indexes = [...used].sort((a, b) => a - b)
  if (indexes.length === 0) return cleaned.trim()

  const notes = indexes
    .map((index) => `[^${index}]: ${footnoteForSource(sources[index - 1]!)}`)
    .join('\n')
  return `${cleaned.trim()}\n\n${notes}\n`
}
