import type { Finding } from './autoresearch'

export type LexicalInstrument = { unitId: string; terms: string[] }

export type InstrumentOpts = {
  minTermLength?: number
  maxFunctionTermShare?: number
  functionChars?: ReadonlySet<string>
}

/**
 * Closed-class 虛字 / function characters. Topic terms should be content
 * words (名詞、專名、術語). A ground-truth builder that windows raw
 * transcript Han runs will scoop up 的了是在我們所以 — the share of
 * terms that are ≥50% these characters is the first broken-instrument
 * signature.
 *
 * 地 is deliberately omitted: the particle 地 is the same code point as
 * the content morpheme in 地神 / 口罩地圖, and this corpus treats those
 * as topic terms.
 */
const FUNCTION_CHAR_LIST =
  '的得了著過是有在從到對於為以用把被給跟向往比將使讓' +
  '和與及或而但且並因所也都就還又再才只卻很太更最不沒未' +
  '我你他她它們這那其此之個些可能會要嗎呢吧啊等來去'

export const DEFAULT_FUNCTION_CHARS: ReadonlySet<string> = new Set(
  Array.from(FUNCTION_CHAR_LIST),
)

/** A term is function-heavy when at least this fraction of its code points are 虛字. */
const FUNCTION_HEAVY_SHARE = 0.5

const DEFAULT_MIN_TERM_LENGTH = 3
/**
 * Calibrated from two real lexicons, not chosen a priori: the fixed-width-sliced
 * held-out artifact measures 40.8% function-heavy, while a DF-curated
 * Intl.Segmenter lexicon over the same passages measures 16.0%. 0.25 separates
 * them with margin on both sides. Only two calibration points, so treat as
 * provisional — widen it rather than curate a lexicon down to satisfy it.
 */
const DEFAULT_MAX_FUNCTION_TERM_SHARE = 0.25

/** Below this n, a length histogram is not a distribution. */
const FIXED_WIDTH_MIN_TERMS = 8


/**
 * A length spike is only the windowing signature when it sits at >=4 characters.
 * Genuine Traditional-Chinese word segmentation concentrates at 2-3: measured
 * over Intl.Segmenter zh-TW output, 81.2% of content words are length 2 and
 * 9.5% length 3. Without this floor the gate blocks correctly segmented ground
 * truth, which is worse than having no gate at all.
 */
const FIXED_WIDTH_MIN_SUSPICIOUS_LENGTH = 4
/** Single-length spike: one n-gram width ate the lexicon. */
const FIXED_WIDTH_SINGLE_SPIKE = 0.55

/**
 * Two adjacent lengths (e.g. 4 and 5) covering this fraction — the
 * "Han runs 3–8, else non-overlapping 4–5 slices" builder.
 */
const FIXED_WIDTH_ADJACENT_SPIKE = 0.7

export function functionCharShare(
  term: string,
  functionChars: ReadonlySet<string> = DEFAULT_FUNCTION_CHARS,
): number {
  const chars = Array.from(term)
  if (chars.length === 0) return 0
  let hits = 0
  for (const ch of chars) {
    if (functionChars.has(ch)) hits++
  }
  return hits / chars.length
}

function isHanCodePoint(ch: string): boolean {
  const cp = ch.codePointAt(0)
  return cp !== undefined && cp >= 0x4e00 && cp <= 0x9fff
}

function termHasHan(term: string): boolean {
  for (const ch of Array.from(term)) {
    if (isHanCodePoint(ch)) return true
  }
  return false
}

function emptySlice(): {
  sliced: boolean
  dominantLengths: number[]
  share: number
} {
  return { sliced: false, dominantLengths: [], share: 0 }
}

/**
 * Chinese has no space delimiters, so a real word segmenter produces a
 * varied length distribution while fixed-width n-gram windowing produces
 * a spike at one or two lengths. That spike is the signature of a broken
 * ground-truth builder.
 *
 * Latin-only tokens are ignored: they already have spaces and are not
 * what the n-gram slicer is doing. Empty terms are ignored.
 *
 * Returns the dominant length(s) and the share they cover so a blocker
 * can quote the numbers a human needs to tell "sliced" from "just short".
 */
export function looksFixedWidthSliced(terms: readonly string[]): {
  sliced: boolean
  dominantLengths: number[]
  share: number
} {
  const lengths: number[] = []
  for (const term of terms) {
    const chars = Array.from(term)
    if (chars.length === 0) continue
    let han = 0
    for (const ch of chars) {
      if (isHanCodePoint(ch)) han++
    }
    if (han === 0) continue
    lengths.push(chars.length)
  }

  if (lengths.length < FIXED_WIDTH_MIN_TERMS) return emptySlice()

  const hist = new Map<number, number>()
  for (const len of lengths) {
    hist.set(len, (hist.get(len) ?? 0) + 1)
  }

  const ranked: Array<[number, number]> = []
  for (const entry of hist) ranked.push(entry)
  ranked.sort((a, b) => b[1] - a[1] || a[0] - b[0])

  const total = lengths.length
  const topLen = ranked[0][0]
  const topShare = ranked[0][1] / total

  // Only a spike at >=4 chars indicates fixed-width windowing; 2-3 is the normal
  // shape of Chinese vocabulary. See FIXED_WIDTH_MIN_SUSPICIOUS_LENGTH.
  const suspiciousWidth = (len: number): boolean => len >= FIXED_WIDTH_MIN_SUSPICIOUS_LENGTH

  // Adjacent 4+5 (or similar) window first: that is the real builder
  // signature. A single-length check at ≥0.55 would otherwise hide it
  // (length 4 alone is 57% in the broken artifact; 4+5 together is ~82%).
  if (ranked.length >= 2) {
    const lenA = ranked[0][0]
    const nA = ranked[0][1]
    const lenB = ranked[1][0]
    const nB = ranked[1][1]
    const adjacent = lenA - lenB === 1 || lenB - lenA === 1
    const share = (nA + nB) / total
    if (adjacent && share >= FIXED_WIDTH_ADJACENT_SPIKE && suspiciousWidth(lenA) && suspiciousWidth(lenB)) {
      const dominantLengths = lenA < lenB ? [lenA, lenB] : [lenB, lenA]
      return { sliced: true, dominantLengths, share }
    }
  }

  if (topShare >= FIXED_WIDTH_SINGLE_SPIKE && suspiciousWidth(topLen)) {
    return { sliced: true, dominantLengths: [topLen], share: topShare }
  }

  return {
    sliced: false,
    dominantLengths: [topLen],
    share: topShare,
  }
}

function resolveOpts(opts?: InstrumentOpts): {
  minTermLength: number
  maxFunctionTermShare: number
  functionChars: ReadonlySet<string>
} {
  return {
    minTermLength: opts?.minTermLength ?? DEFAULT_MIN_TERM_LENGTH,
    maxFunctionTermShare: opts?.maxFunctionTermShare ?? DEFAULT_MAX_FUNCTION_TERM_SHARE,
    functionChars: opts?.functionChars ?? DEFAULT_FUNCTION_CHARS,
  }
}

function eligibleTerms(
  terms: readonly string[],
  minTermLength: number,
): string[] {
  const out: string[] = []
  for (const term of terms) {
    if (Array.from(term).length >= minTermLength) out.push(term)
  }
  return out
}

function flattenTerms(
  instruments: readonly LexicalInstrument[],
  minTermLength: number,
): string[] {
  const out: string[] = []
  for (const inst of instruments) {
    for (const term of eligibleTerms(inst.terms, minTermLength)) out.push(term)
  }
  return out
}

function countFunctionHeavy(
  terms: readonly string[],
  functionChars: ReadonlySet<string>,
): { total: number; heavy: number } {
  let total = 0
  let heavy = 0
  for (const term of terms) {
    total++
    if (functionCharShare(term, functionChars) >= FUNCTION_HEAVY_SHARE) {
      heavy++
    }
  }
  return { total, heavy }
}

function meanLength(terms: readonly string[]): number {
  let n = 0
  let sum = 0
  for (const term of terms) {
    n++
    sum += Array.from(term).length
  }
  return n === 0 ? 0 : sum / n
}

function lengthHistogram(terms: readonly string[]): Map<number, number> {
  const hist = new Map<number, number>()
  for (const term of terms) {
    const chars = Array.from(term)
    hist.set(chars.length, (hist.get(chars.length) ?? 0) + 1)
  }
  return hist
}

function formatHist(hist: Map<number, number>): string {
  const keys: number[] = []
  for (const k of hist.keys()) keys.push(k)
  keys.sort((a, b) => a - b)
  const parts: string[] = []
  for (const k of keys) {
    parts.push(`${k}:${hist.get(k)}`)
  }
  return parts.join(' ')
}

function uniqueUnitIds(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function unitsWithFunctionHeavy(
  instruments: readonly LexicalInstrument[],
  minTermLength: number,
  functionChars: ReadonlySet<string>,
): string[] {
  const ids: string[] = []
  for (const inst of instruments) {
    for (const term of eligibleTerms(inst.terms, minTermLength)) {
      if (functionCharShare(term, functionChars) >= FUNCTION_HEAVY_SHARE) {
        ids.push(inst.unitId)
        break
      }
    }
  }
  return uniqueUnitIds(ids)
}

function unitsWithDominantLengths(
  instruments: readonly LexicalInstrument[],
  minTermLength: number,
  dominantLengths: readonly number[],
): string[] {
  const wanted = new Set(dominantLengths)
  const ids: string[] = []
  for (const inst of instruments) {
    for (const term of eligibleTerms(inst.terms, minTermLength)) {
      if (!termHasHan(term)) continue
      if (wanted.has(Array.from(term).length)) {
        ids.push(inst.unitId)
        break
      }
    }
  }
  return uniqueUnitIds(ids)
}

export function auditLexicalInstrument(
  instruments: readonly LexicalInstrument[],
  opts?: InstrumentOpts,
): Finding[] {
  const { minTermLength, maxFunctionTermShare, functionChars } = resolveOpts(opts)
  const terms = flattenTerms(instruments, minTermLength)
  const findings: Finding[] = []
  const { total, heavy } = countFunctionHeavy(terms, functionChars)
  const heavyFrac = total === 0 ? 0 : heavy / total
  const mean = meanLength(terms)
  const hist = lengthHistogram(terms)
  const slice = looksFixedWidthSliced(terms)

  if (total > 0 && heavyFrac >= maxFunctionTermShare) {
    const pct = (heavyFrac * 100).toFixed(1)
    findings.push({
      severity: 'blocker',
      gate: 'function-char-share',
      unitIds: unitsWithFunctionHeavy(instruments, minTermLength, functionChars),
      message:
        `${heavy}/${total} terms (${pct}%) have ≥${FUNCTION_HEAVY_SHARE * 100}% ` +
        `function characters (mean length ${mean.toFixed(2)}); ` +
        `a topic lexicon should be content words, not 的了是在 windows`,
    })
  }

  if (slice.sliced) {
    const pctMean = mean.toFixed(2)
    const sharePct = (slice.share * 100).toFixed(1)
    const lengths = slice.dominantLengths.join('+')
    findings.push({
      severity: 'blocker',
      gate: 'fixed-width-sliced',
      unitIds: unitsWithDominantLengths(
        instruments,
        minTermLength,
        slice.dominantLengths,
      ),
      message:
        `${total} terms, mean length ${pctMean}, histogram {${formatHist(hist)}}; ` +
        `dominant lengths ${lengths} cover ${sharePct}% — ` +
        `fixed-width n-gram windowing spikes at one or two lengths, ` +
        `unlike a real Chinese word segmenter`,
    })
  }

  return findings
}
