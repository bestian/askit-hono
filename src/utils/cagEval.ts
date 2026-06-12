export const CAG_MODEL_GEMMA = '@cf/google/gemma-4-26b-a4b-it'

export const CAG_EVAL_PASS_RATIO = 0.9

export type CagModelPricing = {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
}

export const CAG_MODEL_PRICING: Record<string, CagModelPricing> = {
  [CAG_MODEL_GEMMA]: { inputPerMillionUsd: 0.10, outputPerMillionUsd: 0.30 },
}

/** Typical CAG request token profile used for /cag/status cost estimates. */
export const CAG_TYPICAL_INPUT_TOKENS = 6_700
export const CAG_TYPICAL_OUTPUT_TOKENS = 300

export type CagEvalCase = {
  id: string
  question: string
  requireTraditionalChinese?: boolean
  minCitations?: number
}

export const DEFAULT_CAG_EVAL_CASES: CagEvalCase[] = [
  {
    id: 'earth-god-incense',
    question: '用 #zh-tw 回答：地神香火如何',
    requireTraditionalChinese: true,
    minCitations: 1,
  },
  {
    id: 'digital-signature',
    question: '用 #zh-tw 回答：數位簽章是什麼',
    requireTraditionalChinese: true,
    minCitations: 1,
  },
  {
    id: 'open-source-policy',
    question: '用 #zh-tw 回答：開源軟體政策',
    requireTraditionalChinese: true,
    minCitations: 1,
  },
  {
    id: 'cybersecurity',
    question: '用 #zh-tw 回答：資通安全',
    requireTraditionalChinese: true,
    minCitations: 1,
  },
  {
    id: 'civic-participation',
    question: '用 #zh-tw 回答：公民參與',
    requireTraditionalChinese: true,
    minCitations: 1,
  },
  {
    id: 'open-data-en',
    question: 'What did Audrey Tang say about open government data?',
    minCitations: 1,
  },
  {
    id: 'misinformation',
    question: '用 #zh-tw 回答：假訊息防治',
    requireTraditionalChinese: true,
    minCitations: 1,
  },
  {
    id: 'ai-governance',
    question: '用 #zh-tw 回答：AI 治理',
    requireTraditionalChinese: true,
    minCitations: 1,
  },
]

export type CagEvalScore = {
  passed: boolean
  checks: {
    hasContent: boolean
    hasCitations: boolean
    validCitationIndexes: boolean
    minCitationsMet: boolean
    traditionalChinese: boolean
  }
  citedIndexes: number[]
}

const CITATION_PATTERN = /\[(\^?)(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g

/** Simplified-only forms that rarely appear in intentional zh-TW answers. */
const SIMPLIFIED_MARKERS = /[国发]/u

export function extractCitationIndexes(answer: string): number[] {
  const indexes = new Set<number>()
  for (const match of answer.matchAll(CITATION_PATTERN)) {
    for (const part of match[2].split(',')) {
      const index = Number(part.trim())
      if (Number.isInteger(index) && index > 0) indexes.add(index)
    }
  }
  return [...indexes].sort((a, b) => a - b)
}

export function looksTraditionalChinese(text: string): boolean {
  if (!/\p{Script=Han}/u.test(text)) return false
  return !SIMPLIFIED_MARKERS.test(text)
}

export function scoreCagAnswer(
  answer: string,
  sourceCount: number,
  options?: {
    requireTraditionalChinese?: boolean
    minCitations?: number
  },
): CagEvalScore {
  const trimmed = answer.trim()
  const citedIndexes = extractCitationIndexes(answer)
  const minCitations = Math.max(1, options?.minCitations ?? 1)

  const looksLikeJson = trimmed.startsWith('{') && trimmed.includes('"choices"')
  const hasContent = trimmed.length > 20 && !looksLikeJson
  const hasCitations = citedIndexes.length > 0
  const validCitationIndexes = citedIndexes.every(
    (index) => index >= 1 && index <= sourceCount,
  )
  const minCitationsMet = citedIndexes.length >= minCitations
  const traditionalChinese = options?.requireTraditionalChinese
    ? looksTraditionalChinese(trimmed)
    : true

  const checks = {
    hasContent,
    hasCitations,
    validCitationIndexes,
    minCitationsMet,
    traditionalChinese,
  }

  const passed = Object.values(checks).every(Boolean)
  return { passed, checks, citedIndexes }
}

export function estimateCagRequestCostUsd(
  model: string,
  inputTokens = CAG_TYPICAL_INPUT_TOKENS,
  outputTokens = CAG_TYPICAL_OUTPUT_TOKENS,
): number | null {
  const pricing = CAG_MODEL_PRICING[model]
  if (!pricing) return null
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillionUsd
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillionUsd
  return inputCost + outputCost
}

export function evalPassRatio(passed: number, total: number): number {
  if (total === 0) return 0
  return passed / total
}

export function evalMeetsThreshold(passed: number, total: number): boolean {
  return evalPassRatio(passed, total) >= CAG_EVAL_PASS_RATIO
}