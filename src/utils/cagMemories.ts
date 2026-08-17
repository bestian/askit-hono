import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import path from 'node:path'

import type { CagSource } from './cag'
import { extractIndexKeys } from './bigramKeys'

export type CagCategory = 'preference' | 'decision' | 'insight' | 'fact' | 'context'
export type CagPhase = 'observer' | 'audrey'
export type CagLinkType = 'semantic' | 'causal' | 'temporal' | 'entity'

export type CagEvidence = {
  file: string
  turnIndex: number
  speaker: string
  startChar: number
  endChar: number
  quote: string
  sectionId?: number | null
}

export type CagMemory = {
  id: string
  extractKey: string
  phase: CagPhase
  category: CagCategory
  importance: 1 | 2 | 3 | 4 | 5
  content: string
  entities: string[]
  tags: string[]
  roomId: string
  roomDate: string
  sourceFile: string
  evidence: CagEvidence[]
  createdAt: string
}

export type CagLink = {
  sourceId: string
  targetId: string
  edgeType: CagLinkType
  weight: number
  why: string
}

export type JsonlRecord =
  | ({ kind: 'memory' } & CagMemory)
  | ({ kind: 'link' } & CagLink)

export type TranscriptTurn = {
  turnIndex: number
  speaker: string
  text: string
}

export type ParsedTranscript = {
  title: string
  roomDate: string
  sourceFile: string
  roomId: string
  turns: TranscriptTurn[]
}

export type CheckpointFile = {
  processed: Record<string, {
    sha256: string
    memoryIds: string[]
    phaseADone: boolean
    phaseBDone: boolean
    /** 0-based count of completed LLM windows; omitted on unwindowed extracts. */
    windowsDone?: number
  }>
}

export type RankedMemory = CagMemory & { score: number }

export type RecallOptions = {
  types?: CagLinkType[]
  roomId?: string
  phase?: CagPhase
  limit?: number
  noLlm?: boolean
  later?: boolean
  minScore?: number
}

export type CagStore = {
  memories: CagMemory[]
  links: CagLink[]
}

const QUOTE_CAP = 240
const MAX_OUTBOUND_LINKS = 8
const SEMANTIC_JACCARD = 0.25
const OBSERVER_AUDREY_JACCARD = 0.4
const CAUSAL_RE = /所以|因此|because|therefore/i
const IMPORTANCE_BUMP_RE = /所以|因此|必須|不要/
const AUDREY_SPEAKER_RE = /唐鳳|Audrey Tang/
export const LOCAL_CHAT_URL = 'http://192.168.1.77:8000/v1/chat/completions'
export const LOCAL_CHAT_MODEL = 'deepseek-v4-flash'
export const LOCAL_EMBED_URL = 'http://127.0.0.1:11434/api/embed'
export const LOCAL_EMBED_MODEL = 'qwen3-embedding:0.6b'
/**
 * Minimum cosine similarity score for the keyword-miss fallback path in `recallHybrid`.
 *
 * Provenance:
 * - Calibrated: 2026-08-17 against merged capped store (/tmp/cag-memories-july-cap4,
 *   /tmp/cag-memories-ds4-webx3, /tmp/cag-memories-ds4-commons3; 96 memories).
 * - Embedder: qwen3-embedding:0.6b (1024-dim, L2-normalized) via local Ollama.
 * - Sample: 21 eval questions (DEFAULT_CAG_EVAL_CASES + DEFAULT_AUDREY_EVAL_CASES), 2016 pairs.
 *   - Should-Match (n=24):    min 0.2638, p10 0.3630, median 0.4657, p90 0.6344, max 0.6832
 *   - Should-Not-Match (n=1992): min 0.1240, p10 0.2545, median 0.3350, p90 0.4287, max 0.6175
 * - Note: The distributions overlap heavily between 0.2638 and 0.6175. This threshold (0.62) is
 *   fitted to this sample and not held out; it clears the false-positive noise ceiling (0.6175 max)
 *   on keyword-miss fallback, yielding 7/7 honest out-of-corpus abstentions in the sample.
 */
export const DEFAULT_MEMORY_MIN_COSINE_SCORE = 0.62

export function memoryIdForExtractKey(extractKey: string): string {
  const h = createHash('sha256').update(extractKey).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function clampExtractImportance(phase: CagPhase, raw: number | undefined): 1|2|3|4|5 {
  const n = Math.max(1, Math.min(5, Math.round(raw ?? (phase === 'audrey' ? 4 : 3))))
  if (phase === 'audrey' && n < 4) return 4
  return n as 1|2|3|4|5
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Fence-strip, then JSON.parse first `[`..last `]`. Invalid or truncated → []. Never throws. */
export function parseJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced?.[1] ?? text).trim()
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end < start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function isWindowTimeout(msg: string): boolean {
  return /timeout/i.test(msg)
}

export function parseTranscriptMarkdown(markdown: string, sourceFile: string): ParsedTranscript {
  const roomId = path.basename(sourceFile)
  const dateMatch = roomId.match(/^(\d{4}-\d{2}-\d{2})/)
  const roomDate = dateMatch?.[1] ?? '1970-01-01'
  const titleMatch = markdown.match(/^#\s+(.+)$/m)
  const title = (titleMatch?.[1] ?? roomId).trim()
  const chunks = markdown.split(/^### /m)
  const turns: TranscriptTurn[] = []
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i] ?? ''
    const nl = chunk.indexOf('\n')
    const header = (nl === -1 ? chunk : chunk.slice(0, nl)).trim()
    const body = nl === -1 ? '' : chunk.slice(nl + 1)
    const speaker = header.replace(/[：:]\s*$/, '').trim()
    turns.push({ turnIndex: i - 1, speaker, text: body.replace(/\s+$/, '') })
  }
  return { title, roomDate, sourceFile, roomId, turns }
}

/** Strip `<br>` tags and whitespace; map each kept char back to the original index. */
function collapseBrAndWs(text: string): { collapsed: string; map: number[] } {
  const collapsed: string[] = []
  const map: number[] = []
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const br = rest.match(/^<br\s*\/?>/i)
    if (br) {
      i += br[0].length
      continue
    }
    const ch = text[i] ?? ''
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    collapsed.push(ch)
    map.push(i)
    i += 1
  }
  return { collapsed: collapsed.join(''), map }
}

/** Locate `needle` in a turn, collapsing `<br>` and whitespace when the raw string misses. */
export function findSpan(turnText: string, needle: string): { startChar: number; endChar: number; quote: string } {
  const n = needle.trim()
  if (!n) return { startChar: 0, endChar: 0, quote: '' }
  let idx = turnText.indexOf(n)
  if (idx >= 0) {
    const end = Math.min(turnText.length, idx + Math.min(n.length, QUOTE_CAP))
    return { startChar: idx, endChar: end, quote: turnText.slice(idx, end) }
  }
  const turned = collapseBrAndWs(turnText)
  const need = collapseBrAndWs(n)
  const cidx = need.collapsed ? turned.collapsed.indexOf(need.collapsed) : -1
  if (cidx >= 0) {
    const startChar = turned.map[cidx] ?? 0
    const last = turned.map[cidx + need.collapsed.length - 1] ?? startChar
    const endChar = last + 1
    return { startChar, endChar, quote: turnText.slice(startChar, endChar) }
  }
  const head = n.slice(0, Math.min(24, n.length))
  idx = head ? turnText.indexOf(head) : 0
  if (idx < 0) idx = 0
  const end = Math.min(turnText.length, idx + Math.min(Math.max(n.length, 1), QUOTE_CAP))
  return { startChar: idx, endChar: end, quote: turnText.slice(idx, end) }
}

/** Same tag/entity stripping as `scripts/vectorize-sync.ts` / `scripts/build-ask-index.ts`. */
export function htmlToPlainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Same `<br>` + whitespace collapse `findSpan` uses on the needle. */
export function collapseBrAndWsText(text: string): string {
  return text.replace(/<br\s*\/?>/gi, '').replace(/\s+/g, '')
}

export type ArchiveSection = {
  section_id: number
  section_content: string
  name?: string
  filename?: string
  display_name?: string
}

export type SectionResolveHit = {
  sectionId: number
  via: 'quote-in-section' | 'section-in-quote'
}

export function parseArchiveSpeechPayload(payload: unknown): ArchiveSection[] {
  const raw = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { sections?: unknown }).sections)
      ? (payload as { sections: unknown[] }).sections
      : []
  const out: ArchiveSection[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const sectionId = rec.section_id
    if (typeof sectionId !== 'number' || !Number.isFinite(sectionId)) continue
    out.push({
      section_id: sectionId,
      section_content: typeof rec.section_content === 'string' ? rec.section_content : '',
      name: typeof rec.name === 'string' ? rec.name : undefined,
      filename: typeof rec.filename === 'string' ? rec.filename : undefined,
      display_name: typeof rec.display_name === 'string' ? rec.display_name : undefined,
    })
  }
  return out
}

export function filenameFromRoomId(roomId: string): string {
  return roomId.replace(/\.md$/i, '')
}

const ARCHIVE_CJK_PUNCT_RE = /[：「」《》＋⁺、（）]/g

/**
 * The canonical archive.tw slug: lowercase ASCII + CJK punctuation DELETED + collapsed
 * hyphens. Measured over 105 rooms: the raw basename resolves for only 49; lowercasing
 * ASCII recovers 34 more and deleting this punctuation set recovers 15 more. Folding the
 * punctuation to a hyphen instead recovered ZERO — that spelling exists in Vectorize
 * metadata but not in the archive.tw section API. Applying this unconditionally is safe:
 * the 49 already-working rooms carry no uppercase ASCII and no CJK punctuation, so it is
 * a no-op for them.
 */
export function archiveCanonicalSlug(filename: string): string {
  return filename
    .replace(/[A-Z]/g, (ch) => ch.toLowerCase())
    .replace(ARCHIVE_CJK_PUNCT_RE, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Slug candidates, most-specific first: [as-is, lowercase-ASCII, canonical]. Deduplicated. */
export function archiveSlugCandidates(filename: string): string[] {
  const lower = filename.replace(/[A-Z]/g, (ch) => ch.toLowerCase())
  const out: string[] = []
  for (const slug of [filename, lower, archiveCanonicalSlug(filename)]) {
    if (!out.includes(slug)) out.push(slug)
  }
  return out
}

export function archiveSectionHref(filename: string, sectionId: number): string {
  return `https://archive.tw/${archiveCanonicalSlug(filename)}#s${sectionId}`
}

function normalizeForSectionMatch(text: string): string {
  return collapseBrAndWsText(htmlToPlainText(text))
}

/** Join a quote to a section: collapse `<br>` + whitespace on both sides after htmlToPlainText. */
export function resolveSectionMatch(quote: string, sections: ArchiveSection[]): SectionResolveHit | null {
  const q = normalizeForSectionMatch(quote)
  if (!q) return null
  let best: SectionResolveHit | null = null
  let bestLen = 0
  for (const section of sections) {
    const t = normalizeForSectionMatch(section.section_content)
    if (!t) continue
    if (t.includes(q)) return { sectionId: section.section_id, via: 'quote-in-section' }
    if (q.includes(t) && t.length > bestLen) {
      best = { sectionId: section.section_id, via: 'section-in-quote' }
      bestLen = t.length
    }
  }
  return best
}

export function resolveSectionId(quote: string, sections: ArchiveSection[]): number | null {
  return resolveSectionMatch(quote, sections)?.sectionId ?? null
}

export async function fetchArchiveSections(
  filename: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<ArchiveSection[]> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = (opts.baseUrl ?? 'https://archive.tw').replace(/\/$/, '')
  // The raw basename resolves for only 49 of 105 rooms; try the folded slugs too.
  for (const slug of archiveSlugCandidates(filename)) {
    const res = await fetchImpl(`${base}/api/speech/${encodeURIComponent(slug)}`)
    if (!res.ok) continue
    const sections = parseArchiveSpeechPayload(await res.json())
    if (sections.length > 0) return sections
  }
  return []
}

function isUrlOrLinkResidue(text: string): boolean {
  const t = text.trim()
  if (/https?:/i.test(t)) return true
  if (/\]\(/.test(t)) return true
  const stripped = t.replace(/\s+/g, '')
  return stripped.length < 8
}

function splitClaims(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/)
  const claims: string[] = []
  for (const para of paragraphs) {
    const kept = para
      .split('\n')
      .filter((line) => !/^\s*>\s/.test(line) && !isUrlOrLinkResidue(line))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
    if (!kept || isUrlOrLinkResidue(kept)) continue
    claims.push(kept)
  }
  return claims
}

const SPEAKER_ENTITY_RE = /唐鳳|Audrey Tang/i
const COMMON_CJK_BIGRAMS = new Set([
  '我們', '你們', '他們', '這個', '那個', '這些', '那些', '一個', '不是', '就是',
  '可以', '因為', '所以', '因此', '還有', '以及', '自己', '什麼', '沒有', '如果',
  '已經', '這樣', '那樣', '然後', '但是', '而且', '或者', '雖然', '不過', '能夠',
  '需要', '透過', '進行', '作為', '對於', '也是', '都是', '有些', '一些', '這種',
])

/** Drop speaker names (唐鳳 / Audrey Tang), including if they appeared in 「」. */
export function sanitizeEntities(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of list) {
    const v = String(raw ?? '').trim()
    if (!v) continue
    if (SPEAKER_ENTITY_RE.test(v)) continue
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

function extractEntities(text: string): string[] {
  const quoted = new Set<string>()
  for (const m of text.matchAll(/「([^」]+)」/g)) {
    const v = m[1]?.trim()
    if (v && v.length >= 2 && v.length <= 24) quoted.add(v)
  }
  const out = new Set<string>(quoted)
  for (const m of text.matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)) {
    out.add(m[0])
  }
  return sanitizeEntities([...out])
}

function sharedTokensAreOnlyCommonCjkBigrams(a: Set<string>, b: Set<string>): boolean {
  const shared = [...a].filter((t) => b.has(t))
  if (shared.length === 0) return false
  return shared.every((t) => t.length === 2 && COMMON_CJK_BIGRAMS.has(t))
}

function tokenize(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) out.add(m[0].toLowerCase())
  const cjk = [...text].filter((ch) => /\p{Script=Han}/u.test(ch)).join('')
  for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2))
  if (cjk.length === 1) out.add(cjk)
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function memoryTokenCorpus(mem: CagMemory): string {
  let text = mem.content
  for (const ev of mem.evidence) {
    if (ev.quote) text += `\n${ev.quote}`
  }
  return text
}

function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) {
    const w = m[0].toLowerCase()
    if (w.length >= 2) out.add(w)
  }
  const cjk = [...text].filter((ch) => /\p{Script=Han}/u.test(ch)).join('')
  for (let i = 0; i < cjk.length - 1; i++) {
    const bigram = cjk.slice(i, i + 2)
    if (!COMMON_CJK_BIGRAMS.has(bigram)) out.add(bigram)
  }
  return out
}

function audreyIdsWithRoomUniqueToken(audrey: CagMemory[]): Set<string> {
  const byRoom = new Map<string, CagMemory[]>()
  for (const m of audrey) {
    const list = byRoom.get(m.roomId)
    if (list) list.push(m)
    else byRoom.set(m.roomId, [m])
  }
  const pinned = new Set<string>()
  for (const roomMems of byRoom.values()) {
    const owners = new Map<string, string>()
    const collided = new Set<string>()
    const tokensByMem = roomMems.map((m) => [m.id, distinctiveTokens(memoryTokenCorpus(m))] as const)
    for (const [id, tokens] of tokensByMem) {
      for (const t of tokens) {
        if (collided.has(t)) continue
        const prev = owners.get(t)
        if (prev === undefined) owners.set(t, id)
        else if (prev !== id) {
          owners.delete(t)
          collided.add(t)
        }
      }
    }
    for (const [id, tokens] of tokensByMem) {
      for (const t of tokens) {
        if (owners.get(t) === id) {
          pinned.add(id)
          break
        }
      }
    }
  }
  return pinned
}

/** Keep 1 highest-importance observer and ≤12 audrey; rescue ≤3 dropped room-unique shorts. */
export function capWindowedMemories(memories: CagMemory[]): CagMemory[] {
  const observers = memories.filter((m) => m.phase === 'observer')
  const audrey = memories.filter((m) => m.phase === 'audrey')
  const observerKept = [...observers].sort((a, b) => b.importance - a.importance).slice(0, 1)

  const uniqueIds = audreyIdsWithRoomUniqueToken(audrey)
  const compare = (a: CagMemory, b: CagMemory) =>
    b.importance - a.importance ||
    Number(uniqueIds.has(b.id)) - Number(uniqueIds.has(a.id)) ||
    a.content.length - b.content.length

  const uniqueHigh = audrey.filter((m) => uniqueIds.has(m.id) && m.importance >= 4).sort(compare)
  const rest = audrey.filter((m) => !(uniqueIds.has(m.id) && m.importance >= 4)).sort(compare)

  const audreyKept: CagMemory[] = []
  for (const m of uniqueHigh) {
    if (audreyKept.length >= 12) break
    audreyKept.push(m)
  }
  for (const m of rest) {
    if (audreyKept.length >= 12) break
    audreyKept.push(m)
  }

  const keptIds = new Set(audreyKept.map((m) => m.id))
  const droppedUnique = audrey
    .filter((m) => !keptIds.has(m.id) && uniqueIds.has(m.id) && m.importance >= 4)
    .sort((a, b) => a.content.length - b.content.length || b.importance - a.importance)
    .slice(0, 3)

  const rescuedIds = new Set<string>()
  for (const rescue of droppedUnique) {
    let victimIdx = -1
    for (let i = 0; i < audreyKept.length; i++) {
      const cand = audreyKept[i]
      if (!cand || rescuedIds.has(cand.id)) continue
      const cur = victimIdx < 0 ? undefined : audreyKept[victimIdx]
      if (!cur) {
        victimIdx = i
        continue
      }
      const candOk = !(uniqueIds.has(cand.id) && cand.content.length <= 120)
      const curOk = !(uniqueIds.has(cur.id) && cur.content.length <= 120)
      if (candOk !== curOk) {
        if (candOk) victimIdx = i
        continue
      }
      if (compare(cur, cand) < 0) victimIdx = i
    }
    if (victimIdx < 0) break
    audreyKept[victimIdx] = rescue
    rescuedIds.add(rescue.id)
  }

  return [...observerKept, ...audreyKept]
}

function entityOverlapCount(a: CagMemory, b: CagMemory): number {
  return a.entities.filter((e) => b.entities.includes(e) && !SPEAKER_ENTITY_RE.test(e)).length
}

function preferAudreyOnTie(current: CagMemory, challenger: CagMemory): CagMemory {
  if (challenger.phase === 'audrey' && current.phase !== 'audrey') return challenger
  return current
}

/** Earlier audrey in another room. Observer is never a source or target. No last-memory fallback. */
function pickPreviousRoomTemporalTarget(mem: CagMemory, earlier: CagMemory[]): CagMemory | undefined {
  const pool = earlier.filter((t) => t.phase === 'audrey' && t.roomId !== mem.roomId)

  let bestEntity: CagMemory | undefined
  let bestOverlap = 0
  for (const target of pool) {
    const overlap = entityOverlapCount(mem, target)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      bestEntity = target
    } else if (overlap > 0 && overlap === bestOverlap && bestEntity) {
      bestEntity = preferAudreyOnTie(bestEntity, target)
    }
  }
  if (bestEntity && bestOverlap > 0) return bestEntity

  const memTok = tokenize(mem.content)
  let bestJacMem: CagMemory | undefined
  let bestJac = 0
  for (const target of pool) {
    const jac = jaccard(memTok, tokenize(target.content))
    if (jac > bestJac) {
      bestJac = jac
      bestJacMem = target
    } else if (jac === bestJac && jac >= SEMANTIC_JACCARD && bestJacMem) {
      bestJacMem = preferAudreyOnTie(bestJacMem, target)
    }
  }
  if (bestJacMem && bestJac >= SEMANTIC_JACCARD) return bestJacMem
  return undefined
}

/** One alreadyWritten audrey with entity overlap > 0 (not in-batch). */
function pickEntityContinuation(mem: CagMemory, alreadyWritten: CagMemory[]): CagMemory | undefined {
  const pool = alreadyWritten.filter((t) => t.phase === 'audrey' && t.roomId !== mem.roomId)
  let best: CagMemory | undefined
  let bestOverlap = 0
  for (const target of pool) {
    const overlap = entityOverlapCount(mem, target)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = target
    } else if (overlap > 0 && overlap === bestOverlap && best) {
      best = preferAudreyOnTie(best, target)
    }
  }
  return bestOverlap > 0 ? best : undefined
}

function isoFromRoomDate(roomDate: string): string {
  const now = new Date().toISOString().slice(11)
  return `${roomDate}T${now}`
}

function evidenceFromTurn(file: string, turn: TranscriptTurn, spanText: string): CagEvidence {
  const { startChar, endChar, quote } = findSpan(turn.text, spanText)
  return {
    file,
    turnIndex: turn.turnIndex,
    speaker: turn.speaker,
    startChar,
    endChar,
    quote,
  }
}

export type ExtractHeuristicOpts = {
  /** Human-digest 1 observer + 12 audrey. Default false: index path keeps every claim. */
  cap?: boolean
}

export function extractHeuristic(
  parsed: ParsedTranscript,
  alreadyWritten: CagMemory[] = [],
  opts: ExtractHeuristicOpts = {},
): { memories: CagMemory[]; links: CagLink[] } {
  const memories: CagMemory[] = []
  const speakers = [...new Set(parsed.turns.map((t) => t.speaker))]
  const createdAt = isoFromRoomDate(parsed.roomDate)

  const firstTurn = parsed.turns[0]
  if (firstTurn && firstTurn.text.trim()) {
    const extractKey = `${parsed.roomId}#observer#0`
    memories.push({
      id: memoryIdForExtractKey(extractKey),
      extractKey,
      phase: 'observer',
      category: 'context',
      importance: 3,
      content: `Room ${parsed.title}: ${parsed.turns.length} turns; speakers: ${speakers.join('、')}.`,
      entities: extractEntities(parsed.turns.map((t) => t.text).join('\n')),
      tags: ['observer', 'room'],
      roomId: parsed.roomId,
      roomDate: parsed.roomDate,
      sourceFile: parsed.sourceFile,
      evidence: [evidenceFromTurn(parsed.sourceFile, firstTurn, firstTurn.text)],
      createdAt,
    })
  }

  let claimIndex = 0
  for (const turn of parsed.turns) {
    if (!AUDREY_SPEAKER_RE.test(turn.speaker)) continue
    for (const claim of splitClaims(turn.text)) {
      const bump = IMPORTANCE_BUMP_RE.test(claim)
      const extractKey = `${parsed.roomId}#audrey#${claimIndex}`
      const mem: CagMemory = {
        id: memoryIdForExtractKey(extractKey),
        extractKey,
        phase: 'audrey',
        category: bump ? 'insight' : 'fact',
        importance: bump ? 4 : 3,
        content: claim.replace(/<br\s*\/?>/gi, '').replace(/\s+/g, ' ').trim(),
        entities: extractEntities(claim),
        tags: ['audrey'],
        roomId: parsed.roomId,
        roomDate: parsed.roomDate,
        sourceFile: parsed.sourceFile,
        evidence: [evidenceFromTurn(parsed.sourceFile, turn, claim)],
        createdAt,
      }
      memories.push(mem)
      claimIndex++
    }
  }

  // Default: keep every claim; extractKey stays encounter-order audrey#0..N-1.
  // --cap: 1 observer + 12 audrey (importance desc, then length desc). Survivors
  // keep their original extractKey/id so capped is a subset of uncapped.
  const kept = opts.cap ? capHeuristicMemories(memories) : memories
  const links = linkNewMemories(kept, alreadyWritten)
  return { memories: kept, links }
}

function capHeuristicMemories(memories: CagMemory[]): CagMemory[] {
  const observer = memories.filter((m) => m.phase === 'observer').slice(0, 1)
  const audreyCapped = memories
    .filter((m) => m.phase === 'audrey')
    .sort((a, b) => b.importance - a.importance || b.content.length - a.content.length)
    .slice(0, 12)
  return [...observer, ...audreyCapped]
}

export function linkNewMemories(newMemories: CagMemory[], alreadyWritten: CagMemory[]): CagLink[] {
  const links: CagLink[] = []
  const prior: CagMemory[] = []
  let prevAudreyInFile: CagMemory | undefined

  for (const mem of newMemories) {
    const outbound: CagLink[] = []
    const earlier = [...alreadyWritten, ...prior]
    const push = (link: CagLink) => {
      if (outbound.length >= MAX_OUTBOUND_LINKS) return
      if (!earlier.some((m) => m.id === link.targetId)) return
      if (link.sourceId === link.targetId) return
      if (outbound.some((x) => x.targetId === link.targetId && x.edgeType === link.edgeType)) return
      outbound.push({ ...link, weight: Math.max(0, Math.min(1, link.weight)) })
    }

    if (mem.phase === 'audrey' && prevAudreyInFile) {
      push({
        sourceId: mem.id,
        targetId: prevAudreyInFile.id,
        edgeType: 'temporal',
        weight: 0.7,
        why: 'previous Audrey claim in this room',
      })
      const continuation = pickEntityContinuation(mem, alreadyWritten)
      if (continuation) {
        push({
          sourceId: mem.id,
          targetId: continuation.id,
          edgeType: 'temporal',
          weight: 0.55,
          why: 'entity continuation',
        })
      }
    } else if (mem.phase === 'audrey') {
      const target = pickPreviousRoomTemporalTarget(mem, alreadyWritten)
      if (target) {
        push({
          sourceId: mem.id,
          targetId: target.id,
          edgeType: 'temporal',
          weight: 0.55,
          why: 'previous room best match',
        })
      }
    }

    const memTok = tokenize(mem.content)
    const lookback = earlier.slice(-10)
    for (const target of lookback) {
      const sharedEntities = mem.entities.filter(
        (e) => target.entities.includes(e) && !SPEAKER_ENTITY_RE.test(e),
      )
      if (sharedEntities.length > 0) {
        push({
          sourceId: mem.id,
          targetId: target.id,
          edgeType: 'entity',
          weight: 0.6,
          why: `shared entities ${sharedEntities.slice(0, 3).join(', ')}`,
        })
      }
      const tgtTok = tokenize(target.content)
      const jac = jaccard(memTok, tgtTok)
      if (jac >= SEMANTIC_JACCARD && !sharedTokensAreOnlyCommonCjkBigrams(memTok, tgtTok)) {
        push({
          sourceId: mem.id,
          targetId: target.id,
          edgeType: 'semantic',
          weight: jac,
          why: `token Jaccard ${jac.toFixed(2)}`,
        })
      }
    }

    if (CAUSAL_RE.test(mem.content)) {
      const causalTarget = prevAudreyInFile ?? prior.at(-1)
      if (causalTarget) {
        push({
          sourceId: mem.id,
          targetId: causalTarget.id,
          edgeType: 'causal',
          weight: 0.55,
          why: 'causal cue (所以/因此/because/therefore) to earlier memory',
        })
      }
    }

    links.push(...outbound)
    prior.push(mem)
    if (mem.phase === 'audrey') prevAudreyInFile = mem
  }
  return links
}

export function loadCagStore(outDir: string): CagStore {
  const jsonlPath = path.join(outDir, 'memories.jsonl')
  const memoriesById = new Map<string, CagMemory>()
  const linksByKey = new Map<string, CagLink>()
  if (!existsSync(jsonlPath)) return { memories: [], links: [] }
  const text = readFileSync(jsonlPath, 'utf8')
  const pendingLinks: CagLink[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as JsonlRecord
    if (rec.kind === 'memory') {
      const { kind: _k, ...mem } = rec
      memoriesById.set(mem.id, mem)
    } else if (rec.kind === 'link') {
      const { kind: _k, ...link } = rec
      pendingLinks.push(link)
    }
  }
  for (const link of pendingLinks) {
    if (!memoriesById.has(link.sourceId) || !memoriesById.has(link.targetId)) continue
    linksByKey.set(`${link.sourceId}\0${link.targetId}\0${link.edgeType}`, link)
  }
  return { memories: [...memoriesById.values()], links: [...linksByKey.values()] }
}

export function compactCagStore(outDir: string): { memories: number; links: number; droppedMemoryDupes: number } {
  const jsonlPath = path.join(outDir, 'memories.jsonl')
  let rawMemoryLines = 0
  if (existsSync(jsonlPath)) {
    for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const rec = JSON.parse(line) as JsonlRecord
      if (rec.kind === 'memory') rawMemoryLines++
    }
  }
  const store = loadCagStore(outDir)
  mkdirSync(outDir, { recursive: true })
  const records: JsonlRecord[] = [
    ...store.memories.map((m) => ({ kind: 'memory' as const, ...m })),
    ...store.links.map((l) => ({ kind: 'link' as const, ...l })),
  ]
  writeFileSync(jsonlPath, records.length ? `${records.map((r) => JSON.stringify(r)).join('\n')}\n` : '')

  const embeddingsPath = path.join(outDir, 'embeddings.jsonl')
  if (existsSync(embeddingsPath)) {
    const keptIds = new Set(store.memories.map((m) => m.id))
    const kept: string[] = []
    for (const [id, vector] of loadEmbeddingsJsonl(outDir)) {
      if (!keptIds.has(id)) continue
      kept.push(JSON.stringify({ id, vector }))
    }
    writeFileSync(embeddingsPath, kept.length ? `${kept.join('\n')}\n` : '')
  }

  const checkpointPath = path.join(outDir, 'checkpoint.json')
  if (existsSync(checkpointPath)) {
    const cp = loadCheckpoint(outDir)
    const keptIds = new Set(store.memories.map((m) => m.id))
    for (const room of Object.values(cp.processed)) {
      const seen = new Set<string>()
      const next: string[] = []
      for (const id of room.memoryIds) {
        if (!keptIds.has(id) || seen.has(id)) continue
        seen.add(id)
        next.push(id)
      }
      room.memoryIds = next
    }
    saveCheckpoint(outDir, cp)
  }

  return {
    memories: store.memories.length,
    links: store.links.length,
    droppedMemoryDupes: rawMemoryLines - store.memories.length,
  }
}

/** NFKC + lower; strip whitespace and punctuation. Empty → do not collapse. */
function normalizeMemoryContent(content: string): string {
  return content.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '')
}

/** First-wins memories by id, then collapse same normalized content (prefer first audrey). Drop duplicate edges and links whose endpoints were not kept. */
export function mergeCagStores(stores: CagStore[]): CagStore {
  const byId: CagMemory[] = []
  const seenIds = new Set<string>()
  for (const store of stores) {
    for (const mem of store.memories) {
      if (seenIds.has(mem.id)) continue
      seenIds.add(mem.id)
      byId.push(mem)
    }
  }

  const memories: CagMemory[] = []
  const keptIds = new Set<string>()
  const contentIndex = new Map<string, number>()
  for (const mem of byId) {
    const key = normalizeMemoryContent(mem.content)
    if (!key) {
      keptIds.add(mem.id)
      memories.push(mem)
      continue
    }
    const existingIdx = contentIndex.get(key)
    if (existingIdx === undefined) {
      contentIndex.set(key, memories.length)
      keptIds.add(mem.id)
      memories.push(mem)
      continue
    }
    const existing = memories[existingIdx]!
    if (preferAudreyOnTie(existing, mem) === existing) continue
    keptIds.delete(existing.id)
    keptIds.add(mem.id)
    memories[existingIdx] = mem
  }

  const links: CagLink[] = []
  const seenLinks = new Set<string>()
  for (const store of stores) {
    for (const link of store.links) {
      if (!keptIds.has(link.sourceId) || !keptIds.has(link.targetId)) continue
      const key = `${link.sourceId}\0${link.targetId}\0${link.edgeType}`
      if (seenLinks.has(key)) continue
      seenLinks.add(key)
      links.push(link)
    }
  }
  return { memories, links }
}

/** Last-wins by memory id. */
export function mergeEmbeddings(maps: Map<string, number[]>[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const map of maps) {
    for (const [id, vector] of map) out.set(id, vector)
  }
  return out
}

export function dropRoomFromJsonl(outDir: string, roomId: string): string[] {
  const jsonlPath = path.join(outDir, 'memories.jsonl')
  if (!existsSync(jsonlPath)) return []
  const dropped: string[] = []
  const kept: string[] = []
  const dropIds = new Set<string>()
  const lines = readFileSync(jsonlPath, 'utf8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as JsonlRecord
    if (rec.kind === 'memory' && rec.roomId === roomId) dropIds.add(rec.id)
  }
  for (const line of lines) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as JsonlRecord
    if (rec.kind === 'memory' && dropIds.has(rec.id)) {
      dropped.push(rec.id)
      continue
    }
    if (rec.kind === 'link' && (dropIds.has(rec.sourceId) || dropIds.has(rec.targetId))) continue
    kept.push(line)
  }
  writeFileSync(jsonlPath, kept.length ? `${kept.join('\n')}\n` : '')
  return dropped
}

export function appendJsonl(outDir: string, records: JsonlRecord[]): void {
  mkdirSync(outDir, { recursive: true })
  const jsonlPath = path.join(outDir, 'memories.jsonl')
  const chunk = records.map((r) => JSON.stringify(r)).join('\n')
  if (!chunk) return
  appendFileSync(jsonlPath, `${chunk}\n`)
}

export function loadCheckpoint(outDir: string): CheckpointFile {
  const p = path.join(outDir, 'checkpoint.json')
  if (!existsSync(p)) return { processed: {} }
  return JSON.parse(readFileSync(p, 'utf8')) as CheckpointFile
}

export function saveCheckpoint(outDir: string, cp: CheckpointFile): void {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'checkpoint.json'), `${JSON.stringify(cp, null, 2)}\n`)
}

const LATER_QUERY_RE = /後來|之后|之後|later/gi

function stripLaterQuery(query: string): string {
  return query.replace(LATER_QUERY_RE, '').replace(/\s+/g, ' ').trim()
}

function queryWantsLater(query: string, opts: RecallOptions): boolean {
  return Boolean(opts.later) || /後來|之后|之後|later/i.test(query)
}

/** Bump windowsDone for a failed window without marking phases done. */
export function skippedWindowCheckpoint(
  prev: CheckpointFile,
  basename: string,
  sha256: string,
  windowsDone: number,
): CheckpointFile {
  return {
    processed: {
      ...prev.processed,
      [basename]: {
        sha256,
        memoryIds: prev.processed[basename]?.memoryIds ?? [],
        phaseADone: false,
        phaseBDone: false,
        windowsDone,
      },
    },
  }
}

const LATER_SEED_STOP_RE = /後來|之后|之後|later|唐鳳|Audrey|Tang|怎麼|怎樣|如何|談|的|了/gi

function laterSeedNeedles(stripped: string): string[] {
  return stripped
    .replace(LATER_SEED_STOP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}

const EN_QUERY_STOP = new Set([
  'what', 'who', 'whom', 'whose', 'which', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'am', 'be', 'been',
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'shall',
  'may', 'might', 'must', 'did', 'say', 'about', 'mean', 'by', 'the', 'a', 'an',
  'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from',
  'as', 'at', 'if', 'it', 'my', 'no', 'so', 'up', 'we', 'he', 'me', 'us',
  'gov', 'com', 'org', 'net', 'www', 'http', 'https', 'tw', 'html', 'htm',
])

/** Same shape as `stripQuestionDirectives` in cag.ts — copied, not imported. */
function stripQuestionDirectives(question: string): string {
  return question
    .replace(/#[\p{Letter}\p{Number}_-]+/gu, ' ')
    .replace(/^\s*(?:請|麻煩)?\s*用\s+[\s\S]{0,40}?回答[:：]\s*/u, '')
    .replace(/^\s*(?:請|麻煩)?\s*(?:回答|說明|解釋|summarize|answer)\s*[:：]?\s*/iu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function queryKeyText(query: string): string {
  return stripQuestionDirectives(query)
    .replace(LATER_SEED_STOP_RE, ' ')
    .replace(/什麼|影响|什么|為何|爲何|为什么|為什麼|請問|說明|解釋|代表|用在|以及|或者|重新框架的方式/g, ' ')
    .replace(/(?:^|\s)(?:是|為|为)(?=\s|\p{Script=Han}|$)/gu, ' ')
    .replace(/(?<=[\s\p{Script=Han}])(?:是|為|为)(?=\s|$)/gu, ' ')
    .replace(/請用|請|回答|互相支持/g, ' ')
    .replace(/(?<=\s|\p{Script=Han})(?:和|與|及|跟)(?=\s|\p{Script=Han}|$)/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function memoryHay(mem: CagMemory): string {
  return `${mem.content}\n${mem.evidence.map((e) => e.quote).join('\n')}\n${mem.entities.join('\n')}`
}

function extractMemoryKeys(text: string): Set<string> {
  const keys = new Set<string>()
  if (!text) return keys
  for (const m of text.matchAll(/\p{Script=Han}{2,}/gu)) {
    const run = m[0]
    for (let i = 0; i < run.length - 1; i++) keys.add(run.slice(i, i + 2))
    for (let len = 3; len <= Math.min(6, run.length); len++) {
      for (let i = 0; i <= run.length - len; i++) keys.add(run.slice(i, i + len))
    }
  }
  for (const m of text.matchAll(/[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+/g)) {
    keys.add(m[0].toLowerCase())
  }
  for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9]+/g)) {
    keys.add(m[0].toLowerCase())
  }
  return keys
}

const storeDfCache = new WeakMap<CagMemory[], { df: Map<string, number>; nDocs: number }>()

function storeKeyDf(memories: CagMemory[]): { df: Map<string, number>; nDocs: number } {
  const cached = storeDfCache.get(memories)
  if (cached) return cached
  const df = new Map<string, number>()
  for (const mem of memories) {
    for (const key of extractMemoryKeys(memoryHay(mem))) {
      df.set(key, (df.get(key) ?? 0) + 1)
    }
  }
  const stats = { df, nDocs: memories.length }
  storeDfCache.set(memories, stats)
  return stats
}

function idf(key: string, df: Map<string, number>, nDocs: number): number {
  return Math.log((nDocs + 1) / ((df.get(key) ?? 0) + 1)) + 1
}

type SegmenterLocale = 'ja' | 'ko' | 'zh-TW'

const querySegmenters: Partial<Record<SegmenterLocale, Intl.Segmenter>> = {}

function querySegmenter(locale: SegmenterLocale): Intl.Segmenter {
  const cached = querySegmenters[locale]
  if (cached) return cached
  const created = new Intl.Segmenter(locale, { granularity: 'word' })
  querySegmenters[locale] = created
  return created
}

/** Particles / copulas. Length-2 Chinese function words stay on COMMON_CJK_BIGRAMS. */
const CJK_CLOSED_CLASS_CHARS: Record<string, true> = {
  的: true, 了: true, 嗎: true, 呢: true, 吧: true, 啊: true, 呀: true, 喔: true, 哦: true,
  是: true, 有: true, 在: true, 也: true, 都: true, 就: true, 不: true,
  は: true, が: true, を: true, に: true, の: true, へ: true, と: true, で: true, も: true, や: true, か: true,
  은: true, 는: true, 이: true, 가: true, 을: true, 를: true, 에: true, 의: true, 와: true, 과: true, 도: true,
}

/** Script-appropriate locale for Intl.Segmenter: ja for kana, ko for hangul, else zh-TW. */
export function segmenterLocaleFor(text: string): SegmenterLocale {
  if (/\p{Script=Hangul}/u.test(text)) return 'ko'
  if (/\p{Script=Hiragana}/u.test(text) || /\p{Script=Katakana}/u.test(text)) return 'ja'
  return 'zh-TW'
}

/** Content words from a query: Intl.Segmenter word-like segments, function words dropped. */
export function segmentQueryContentTerms(query: string): string[] {
  const text = query.trim()
  if (!text) return []
  let segmenter: Intl.Segmenter
  try {
    segmenter = querySegmenter(segmenterLocaleFor(text))
  } catch {
    return []
  }
  const seen: Record<string, true> = {}
  const out: string[] = []
  try {
    for (const part of segmenter.segment(text)) {
      if (!part.isWordLike) continue
      const raw = part.segment
      const latin = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/.test(raw)
      const term = latin ? raw.toLowerCase() : raw
      if ([...term].length < 2) continue
      if (latin) {
        if (EN_QUERY_STOP.has(term)) continue
      } else {
        if (COMMON_CJK_BIGRAMS.has(term)) continue
        if ([...term].every((ch) => ch in CJK_CLOSED_CLASS_CHARS)) continue
      }
      if (term in seen) continue
      seen[term] = true
      out.push(term)
    }
  } catch {
    return []
  }
  return out
}

/**
 * Han bigrams of `keyText`, stride 2, plus a trailing overlap for odd runs.
 *
 * Two narrowings of this set have been tried against the coverage denominator and
 * BOTH were reverted, for different reasons. (1) Re-chunking
 * `segmentQueryContentTerms(q).join('\n')` destroys bigrams spanning two segments
 * (`談考` in 唐鳳後來怎麼談考場) and regressed 5 later-walk tests. (2) An offset-based
 * content mask preserved those bigrams but measured a NO-OP on all 428 real questions,
 * while re-segmenting the query inside every one of 13k per-memory calls. The denominator
 * problem is not filler — see the coverage computation below.
 */
function queryTopicChunks(keyText: string): string[] {
  const chunks: string[] = []
  for (const m of keyText.matchAll(/\p{Script=Han}{2,}/gu)) {
    const run = m[0] ?? ''
    for (let i = 0; i + 2 <= run.length; i += 2) chunks.push(run.slice(i, i + 2))
    if (run.length % 2 === 1 && run.length >= 3) chunks.push(run.slice(-2))
  }
  return chunks.filter((c) => !COMMON_CJK_BIGRAMS.has(c))
}

function queryTopicPhrases(keyText: string): string[] {
  const phrases: string[] = []
  for (const m of keyText.matchAll(/\p{Script=Han}{3,}/gu)) {
    const run = m[0] ?? ''
    phrases.push(run)
  }
  return phrases
}

function queryLatinTokens(keyText: string): string[] {
  const tokens = new Set<string>()
  for (const m of keyText.matchAll(/[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+/g)) {
    const tok = m[0].toLowerCase()
    if (!EN_QUERY_STOP.has(tok)) tokens.add(tok)
  }
  const clean = keyText.replace(/[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+/g, ' ')
  for (const m of clean.matchAll(/[A-Za-z0-9][A-Za-z0-9]+/g)) {
    const tok = m[0].toLowerCase()
    if (!EN_QUERY_STOP.has(tok) && tok.length >= 2) tokens.add(tok)
  }
  return [...tokens]
}

/** Civic-generic bigrams: present in many rooms, never distinctive alone. Weight 0 in sharedW. */
const CIVIC_GENERIC_BIGRAMS = new Set([
  '政策', '開放', '民主', '公民', '參與', '支持', '數位', '安全',
])

/** Fitted to the 96-memory july-cap4 + ds4-webx3 + ds4-commons3 merge. Not held out. */
const RARE_DF_SHARE = 0.06
const IDF_COVERAGE_MIN = 0.55
/**
 * Coverage is judged over this many highest-IDF query terms. A fraction of ALL terms is
 * unreachable for a long question, which is why 60/60 English audience questions returned
 * nothing while 2-4-term curated prompts passed. 4 is the smallest count that still needs
 * genuine topical agreement rather than one lucky rare token.
 */
const COVERAGE_TOP_TERMS = 4

function keywordScore(
  query: string,
  mem: CagMemory,
  df: Map<string, number> = new Map(),
  nDocs = 1,
): number {
  const content = mem.content
  const quotes = mem.evidence.map((e) => e.quote).join('\n')
  const q = query.trim()
  if (!q) return 0
  const hay = memoryHay(mem)
  const keyText = queryKeyText(q)
  const chunks = queryTopicChunks(keyText)
  const phrases = queryTopicPhrases(keyText)
  const latin = queryLatinTokens(keyText)
  if (chunks.length === 0 && latin.length === 0 && phrases.length === 0) return 0

  const hayKeys = extractMemoryKeys(hay)

  const n = Math.max(1, nDocs)
  // Only the single most distinctive Latin token is mandatory. A conjunction over EVERY
  // Latin token zeroed 60/60 real English questions, because no memory contains all of
  // ~10 content words. A corpus-absent token has df 0, hence maximum IDF, so it is always
  // the one selected and no memory can satisfy it — which is exactly what makes
  // out-of-archive questions abstain (vTaiwan, Higgs boson).
  //
  // MEASURED TRADEOFF, do not "fix" without re-measuring abstention. Restricting this
  // selection to tokens with df > 0 recovers ~5 natural questions and 3 English ones, but
  // drops out-of-archive abstention 15/15 -> 13/15; additionally excluding absent terms
  // from the coverage denominator recovers 60 natural questions and drops it to 9/15.
  // Both were reverted: for a product that must cite sources, converting silence into
  // confident fabrication is the one unacceptable direction. The cost is that one
  // incidental absent word (`chaotic`, `essays`, `horse`) still zeroes a question —
  // 38 of 60 English audience questions carry such a token.
  if (latin.length > 0) {
    let rarest = latin[0]!
    let rarestIdf = idf(rarest, df, n)
    for (const token of latin) {
      const w = idf(token, df, n)
      if (w > rarestIdf) {
        rarest = token
        rarestIdf = w
      }
    }
    if (!hayKeys.has(rarest)) return 0
  }
  let sharedW = 0
  let queryW = 0
  let rareHits = 0
  let distinctiveQuery = 0
  // Per-term weights so coverage can judge the query's most distinctive terms rather than
  // its breadth. `present` marks terms the corpus contains at all: an unmatchable term
  // measures the CORPUS, not this memory, so it must not sit in a per-memory denominator.
  const covTerms: Array<{ w: number; matched: boolean; present: boolean }> = []
  for (const chunk of chunks) {
    const d = df.get(chunk) ?? 0
    const w = idf(chunk, df, n)
    queryW += w
    const civic = CIVIC_GENERIC_BIGRAMS.has(chunk)
    if (!civic) distinctiveQuery++
    const hit = hay.includes(chunk)
    if (!civic) covTerms.push({ w, matched: hit, present: d > 0 })
    if (!hit) continue
    if (civic) continue
    sharedW += w
    if (d <= 1 || d / n <= RARE_DF_SHARE) rareHits++
  }
  for (const phrase of phrases) {
    const d = df.get(phrase) ?? 0
    const w = idf(phrase, df, n) * (phrase.length >= 4 ? 1.5 : 1.0)
    queryW += w
    distinctiveQuery++
    const hit = hay.includes(phrase)
    covTerms.push({ w, matched: hit, present: d > 0 })
    if (hit) {
      sharedW += w
      if (d <= 1 || d / n <= RARE_DF_SHARE) rareHits++
    }
  }
  for (const token of latin) {
    const w = idf(token, df, n)
    const d = df.get(token) ?? 0
    queryW += w
    distinctiveQuery++
    const hit = hayKeys.has(token)
    covTerms.push({ w, matched: hit, present: d > 0 })
    if (hit) {
      sharedW += w
      if (d <= 1 || d / n <= RARE_DF_SHARE) rareHits++
    }
  }
  if (sharedW <= 0) return 0
  // Coverage over the most distinctive terms only, not every term the asker typed.
  // `coverage = sharedW / queryW` over ALL terms is unreachable for a long question:
  // English audience questions carry ~14 content words (90% of which DO occur somewhere
  // in the corpus), so a single ~143-char memory would need ~8 of them to clear 0.55 —
  // and 60/60 English questions returned nothing. Short curated prompts with 2-4 terms
  // clear it easily, which is exactly why the tuned-21 never exposed this. The threshold
  // is unchanged; what changes is which terms it judges.
  // Absent terms STAY in the denominator. Filtering them out was tried and it broke
  // out-of-archive abstention 15/15 -> 9/15: an out-of-archive question whose incidental
  // words are present would clear coverage on those alone. This repeats an overfit this
  // project already reverted once — an unseen query term is the strongest evidence of
  // non-coverage, so removing it removes the very signal that abstention depends on.
  const covRanked = [...covTerms].sort((a, b) => b.w - a.w).slice(0, COVERAGE_TOP_TERMS)
  let covQuery = 0
  let covShared = 0
  for (const t of covRanked) {
    covQuery += t.w
    if (t.matched) covShared += t.w
  }
  const coverage = covQuery > 0 ? covShared / covQuery : 0
  const rareShare = distinctiveQuery > 0 ? rareHits / distinctiveQuery : 0
  const longRare = rareHits >= 1 && rareShare + 1e-9 >= 1 / 3
  if (coverage < IDF_COVERAGE_MIN && !longRare) return 0

  let score = sharedW
  const qInContent = content.includes(q)
  const qInQuotes = mem.phase !== 'observer' && quotes.includes(q)
  const qInEntities = mem.entities.some((e) => e === q)
  if (qInContent) score += content.length <= 120 ? 4 : 1
  else if (qInQuotes) score += 2
  if (qInEntities) score += 2
  if (content.includes(`「${q}」`) || content.includes(`"${q}"`)) score += 5
  const parts = keyText.split(/\s+/).filter((p) => p.length >= 2 && !EN_QUERY_STOP.has(p.toLowerCase()))
  for (const part of parts) {
    if (content.includes(part) || mem.entities.some((e) => e === part)) score += 1
  }
  if (mem.phase === 'observer' && !qInContent) score *= 0.5
  else if (mem.phase === 'observer' && qInContent) score *= 0.85
  else if (mem.phase === 'audrey') score *= 1.35
  return score
}

function dropRedundantObservers(ranked: RankedMemory[], all: CagMemory[] = ranked): RankedMemory[] {
  const audreyRoomIds = new Set(
    all.filter((m) => m.phase === 'audrey').map((m) => m.roomId),
  )
  let kept = ranked
  if (audreyRoomIds.size > 0) {
    kept = kept.filter(
      (m) =>
        !(
          m.phase === 'observer' &&
          m.content.startsWith('Room ') &&
          audreyRoomIds.has(m.roomId)
        ),
    )
  }
  const keptAudrey = kept.filter((m) => m.phase === 'audrey')
  if (keptAudrey.length > 0) {
    kept = kept.filter((m) => {
      if (m.phase !== 'observer') return true
      const obsTok = tokenize(m.content)
      return !keptAudrey.some(
        (a) =>
          a.roomId === m.roomId &&
          jaccard(obsTok, tokenize(a.content)) >= OBSERVER_AUDREY_JACCARD,
      )
    })
  }
  return kept
}

/**
 * True when >= 2 ranked results share one identical score.
 *
 * DIAGNOSTIC ONLY — this must never gate retrieval. Gating on it was tried and refuted:
 * `vTaiwan`, a rare and entirely legitimate query, returns 8 hits at 1 distinct score,
 * because `sharedW` is the IDF sum over matched keys and a single-key match scores every
 * candidate identically. Tie-based abstention regressed a curated 21-question set from 0
 * to 13 empty. Retained because it measured the 57-of-94 degenerate-ranking finding.
 */
export function isDegenerateRanking(memories: readonly RankedMemory[]): boolean {
  if (memories.length < 2) return false
  const first = memories[0]!.score
  return memories.every((m) => Math.abs(m.score - first) <= 1e-9)
}

export function recall(
  query: string,
  store: CagStore,
  opts: RecallOptions = {},
): { memories: RankedMemory[]; evidence: CagEvidence[] } {
  const limit = opts.limit ?? 8
  const stripped = stripLaterQuery(query)
  let pool = store.memories
  if (opts.roomId) pool = pool.filter((m) => m.roomId === opts.roomId)
  if (opts.phase) pool = pool.filter((m) => m.phase === opts.phase)
  if (opts.types?.includes('causal')) {
    const causalIds = new Set<string>()
    for (const link of store.links) {
      if (link.edgeType !== 'causal') continue
      causalIds.add(link.sourceId)
      causalIds.add(link.targetId)
    }
    if (causalIds.size > 0) pool = pool.filter((m) => causalIds.has(m.id))
  }
  if (queryWantsLater(query, opts)) {
    const needles = laterSeedNeedles(stripped)
    pool = pool.filter((m) => {
      if (m.phase !== 'observer' || !m.content.startsWith('Room ')) return true
      return needles.some((t) => m.content.includes(t) || m.evidence.some((e) => e.quote.includes(t)))
    })
  }
  const { df, nDocs } = storeKeyDf(store.memories)
  const ranked: RankedMemory[] = pool
    .map((m) => ({ ...m, score: keywordScore(stripped, m, df, nDocs) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
  let merged = ranked
  if (queryWantsLater(query, opts) && ranked.length > 0) {
    const needles = laterSeedNeedles(stripped)
    const preferred = ranked.filter((m) =>
      needles.some((t) => m.content.includes(t) || m.evidence.some((e) => e.quote.includes(t))),
    )
    const seeds = preferred.slice(0, 1)
    if (seeds.length > 0) {
      const seedIds = new Set(seeds.map((m) => m.id))
      const laterIds = new Set<string>()
      const causalLaterIds = new Set<string>()
      for (const link of store.links) {
        if (link.edgeType !== 'temporal' && link.edgeType !== 'causal') continue
        if (!seedIds.has(link.targetId) || seedIds.has(link.sourceId)) continue
        laterIds.add(link.sourceId)
        if (link.edgeType === 'causal') causalLaterIds.add(link.sourceId)
      }
      const byId = new Map(pool.map((m) => [m.id, m]))
      const mergedById = new Map(seeds.map((m) => [m.id, m]))
      const seedRoomIds = new Set(seeds.map((m) => m.roomId))
      for (const id of laterIds) {
        const mem = byId.get(id)
        if (!mem) continue
        const ks = keywordScore(stripped, mem, df, nDocs)
        if (seedRoomIds.has(mem.roomId) && ks <= 0) continue
        const score = 0.5 * ks + 0.4 + (causalLaterIds.has(id) ? 0.2 : 0)
        const prev = mergedById.get(id)
        if (!prev || score > prev.score) mergedById.set(id, { ...mem, score })
      }
      merged = [...mergedById.values()].sort((a, b) => b.score - a.score)
    }
  }
  merged = dropRedundantObservers(merged, store.memories)
  const sliced = merged.slice(0, limit)
  return {
    memories: sliced,
    evidence: sliced.flatMap((m) => m.evidence),
  }
}

export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return []
  try {
    const res = await fetch(LOCAL_EMBED_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: LOCAL_EMBED_MODEL, input: texts }),
    })
    if (!res.ok) return null
    const body = await res.json() as { embeddings?: number[][] }
    return body.embeddings ?? null
  } catch {
    return null
  }
}

function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0)
  return s
}

export async function recallHybrid(
  query: string,
  store: CagStore,
  embeddings: Map<string, number[]>,
  opts: RecallOptions = {},
): Promise<{ memories: RankedMemory[]; evidence: CagEvidence[] }> {
  const kw = recall(query, store, { ...opts, noLlm: true })
  if (opts.noLlm) return kw
  if (kw.memories.length === 0) {
    const stripped = stripLaterQuery(query)
    let han = ''
    let cur = ''
    for (const ch of stripped) {
      if (/\p{Script=Han}/u.test(ch)) {
        cur += ch
        if (cur.length > han.length) han = cur
      } else {
        cur = ''
      }
    }
    if (han.length <= 2 && !/[A-Za-z]/.test(stripped)) {
      return { memories: [], evidence: [] }
    }
  }
  if (embeddings.size === 0) return kw
  const qv = await embedTexts([query])
  const qvec = qv?.[0]
  if (!qvec) return kw
  const byId = new Map(kw.memories.map((m) => [m.id, m]))
  const limit = opts.limit ?? 8
  const stripped = stripLaterQuery(query)
  const isFallback = kw.memories.length === 0
  let pool: CagMemory[] = kw.memories
  if (isFallback) {
    pool = store.memories
    if (opts.roomId) pool = pool.filter((m) => m.roomId === opts.roomId)
    if (opts.phase) pool = pool.filter((m) => m.phase === opts.phase)
  }
  const minScore = typeof opts.minScore === 'number' && Number.isFinite(opts.minScore)
    ? opts.minScore
    : DEFAULT_MEMORY_MIN_COSINE_SCORE
  const { df, nDocs } = storeKeyDf(store.memories)
  const candidates: RankedMemory[] = []
  for (const m of pool) {
    const kwScore = byId.get(m.id)?.score ?? keywordScore(stripped, m, df, nDocs)
    const ev = embeddings.get(m.id)
    const eScore = ev ? dot(qvec, ev) : 0
    if (isFallback && eScore < minScore) continue
    const score = ev ? 0.6 * eScore + 0.4 * (kwScore / 6) : kwScore
    candidates.push({ ...m, score })
  }
  const ranked: RankedMemory[] = dropRedundantObservers(
    candidates.sort((a, b) => b.score - a.score),
    store.memories,
  ).slice(0, limit)
  return { memories: ranked, evidence: ranked.flatMap((m) => m.evidence) }
}

/** Heuristic extractKeys omit `#llm#`; LLM keys include it so merges cannot collide. */
export function isVerbatimMemory(mem: Pick<CagMemory, 'extractKey'>): boolean {
  return !mem.extractKey.includes('#llm#')
}

export type CagQuoteMode = 'append' | 'content-only'

/** Assembly-only options. Does not change recall, scoring, or citation resolution. */
export type CagSourceAssemblyOpts = {
  /** Default `'append'` keeps content + evidence quotes. `'content-only'` is opt-in. */
  quoteMode?: CagQuoteMode
}

export function memoriesToCagSources(
  memories: CagMemory[],
  titleByRoom: Record<string, string> = {},
  opts: CagSourceAssemblyOpts = {},
): {
  cited: CagSource[]
  background: CagSource[]
} {
  const quoteMode = opts.quoteMode ?? 'append'
  const cited: CagSource[] = []
  const background: CagSource[] = []
  for (const mem of memories) {
    const speaker = mem.evidence[0]?.speaker ?? ''
    const turn = mem.evidence[0]?.turnIndex ?? 0
    const quotes = mem.evidence.map((e) => e.quote).filter(Boolean).join(' / ')
    const rawTitle = titleByRoom[mem.roomId] ?? mem.roomId.replace(/\.md$/, '')
    const title = rawTitle.startsWith(`${mem.roomDate} `) || rawTitle.startsWith(`${mem.roomDate}-`)
      ? rawTitle.slice(mem.roomDate.length + 1)
      : rawTitle
    const resolvedId = mem.evidence
      .map((e) => e.sectionId)
      .find((id): id is number => typeof id === 'number' && Number.isFinite(id))
    const filename = filenameFromRoomId(mem.roomId)
    const citable = mem.phase === 'audrey' && resolvedId != null && isVerbatimMemory(mem)
    const content = quoteMode === 'content-only' || !quotes
      ? mem.content
      : `${mem.content}\n\n${quotes}`
    const source: CagSource = {
      content,
      href: citable
        ? archiveSectionHref(filename, resolvedId)
        : `file://${mem.sourceFile}#turn-${turn}`,
      label: `${mem.roomDate} ${title} — ${speaker}`.trim(),
      sectionId: citable ? resolvedId : null,
    }
    if (citable) cited.push(source)
    else background.push(source)
  }
  return { cited, background }
}

export function loadEmbeddingsJsonl(outDir: string): Map<string, number[]> {
  const p = path.join(outDir, 'embeddings.jsonl')
  const map = new Map<string, number[]>()
  if (!existsSync(p)) return map
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as { id: string; vector: number[] }
    if (rec.id && Array.isArray(rec.vector)) map.set(rec.id, rec.vector)
  }
  return map
}
