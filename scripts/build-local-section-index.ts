/**
 * Build a one-room local cosine index for the offline CAG Worker.
 *
 * Chunks ONLY:
 *   test/fixtures/cag-memories/2026-06-10-創意官吏獎得獎感言.md
 * to ≤175 chars (MAX_SECTION_CHARS), plaintext as in vectorize-sync /
 * build-ask-index, embeds via local Ollama qwen3-embedding:0.6b (1024-dim).
 *
 * NOT bit-comparable to production Vectorize (EmbeddingGemma-300m / 768-dim).
 * Gemma task prefixes are stripped at query time in the AI shim; documents
 * are embedded as raw plaintext so local cosine can clear the 0.45 floor.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/build-local-section-index.ts
 *
 * Writes local/section-index.json (gitignored). No Cloudflare.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  embedTexts,
  LOCAL_EMBED_MODEL,
  LOCAL_EMBED_URL,
  parseTranscriptMarkdown,
} from '../src/utils/cagMemories'

const MAX_SECTION_CHARS = 175
const EMBED_BATCH = 32
const FIXTURE = path.resolve(
  'test/fixtures/cag-memories/2026-06-10-創意官吏獎得獎感言.md',
)
export const LOCAL_SECTION_INDEX_PATH = path.resolve('local/section-index.json')

export type LocalSectionMetadata = {
  section_id: number
  filename: string
  content: string
  display_name: string
  speaker?: string
  nest_filename?: string
}

export type LocalSectionRecord = {
  id: string
  values: number[]
  metadata: LocalSectionMetadata
}

export type LocalSectionIndex = {
  model: string
  dims: number
  minCosine: number
  sourceFile: string
  builtAt: string
  vectors: LocalSectionRecord[]
}

function htmlToPlainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function textLength(s: string): number {
  return Array.from(s).length
}

function chunkPlainText(plain: string, maxChars: number): string[] {
  const text = plain.trim()
  if (!text) return []
  if (textLength(text) <= maxChars) return [text]
  const parts = text.split(/(?<=[。！？.!?…])/u)
  const chunks: string[] = []
  let buf = ''
  const flush = () => {
    const t = buf.trim()
    if (t) chunks.push(t)
    buf = ''
  }
  const hardWrap = (piece: string) => {
    const chars = Array.from(piece)
    for (let i = 0; i < chars.length; ) {
      const slice = chars.slice(i, i + maxChars).join('').trim()
      if (slice) chunks.push(slice)
      i += maxChars
    }
  }
  for (const raw of parts) {
    const piece = raw.trim()
    if (!piece) continue
    const joined = buf ? `${buf}${piece}` : piece
    if (textLength(joined) <= maxChars) {
      buf = joined
      continue
    }
    flush()
    if (textLength(piece) <= maxChars) buf = piece
    else hardWrap(piece)
  }
  flush()
  return chunks
}

function syntheticSectionId(filename: string, turnIndex: number, chunkIndex: number): number {
  const h = createHash('sha256').update(`${filename}\0${turnIndex}\0${chunkIndex}`).digest()
  return h.readUInt32BE(0) >>> 1
}

function l2normalize(v: number[]): number[] {
  let s = 0
  for (const x of v) s += x * x
  const n = Math.sqrt(s)
  if (!Number.isFinite(n) || n === 0) return v
  return v.map((x) => x / n)
}

export function loadLocalSectionIndex(file = LOCAL_SECTION_INDEX_PATH): LocalSectionIndex {
  return JSON.parse(readFileSync(file, 'utf8')) as LocalSectionIndex
}

/** Production Vectorize.query returns raw topK; the Worker then applies 0.45. */
export function queryLocalSectionIndex(
  index: LocalSectionIndex,
  vector: number[],
  options?: { topK?: number; returnMetadata?: 'none' | 'indexed' | 'all' },
): { matches: Array<{ id: string; score: number; metadata?: LocalSectionMetadata | null }> } {
  const topK = Math.max(1, Math.min(options?.topK ?? 4, 12))
  const wantMeta = options?.returnMetadata !== 'none'
  const q = l2normalize(vector)
  const scored: Array<{ id: string; score: number; metadata: LocalSectionMetadata }> = []
  for (const rec of index.vectors) {
    const n = Math.min(q.length, rec.values.length)
    let dot = 0
    for (let i = 0; i < n; i++) dot += (q[i] ?? 0) * (rec.values[i] ?? 0)
    if (!Number.isFinite(dot)) continue
    scored.push({ id: rec.id, score: dot, metadata: rec.metadata })
  }
  scored.sort((a, b) => b.score - a.score)
  return {
    matches: scored.slice(0, topK).map((m) => ({
      id: m.id,
      score: m.score,
      metadata: wantMeta ? m.metadata : null,
    })),
  }
}

async function confirmOllama(): Promise<void> {
  const res = await fetch(new URL('/api/tags', LOCAL_EMBED_URL), {
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`Ollama /api/tags HTTP ${res.status}`)
  const body = (await res.json()) as { models?: Array<{ name?: string }> }
  const names = (body.models ?? []).map((m) => m.name ?? '')
  if (!names.includes(LOCAL_EMBED_MODEL)) {
    throw new Error(`Ollama missing tag ${LOCAL_EMBED_MODEL}. Have: ${names.join(', ')}`)
  }
  console.log(`Ollama up at ${LOCAL_EMBED_URL}; tag ${LOCAL_EMBED_MODEL}`)
}

export async function buildLocalSectionIndex(): Promise<LocalSectionIndex> {
  await confirmOllama()
  const markdown = readFileSync(FIXTURE, 'utf8')
  const parsed = parseTranscriptMarkdown(markdown, FIXTURE)
  const filename = path.basename(FIXTURE, '.md')
  const displayName = parsed.title
  const drafted: LocalSectionMetadata[] = []
  for (const turn of parsed.turns) {
    const chunks = chunkPlainText(htmlToPlainText(turn.text), MAX_SECTION_CHARS)
    for (const [chunkIndex, content] of chunks.entries()) {
      const sectionId = syntheticSectionId(filename, turn.turnIndex, chunkIndex)
      const meta: LocalSectionMetadata = {
        section_id: sectionId,
        filename,
        content,
        display_name: displayName,
      }
      if (turn.speaker) meta.speaker = turn.speaker
      drafted.push(meta)
    }
  }
  if (drafted.length === 0) throw new Error('no chunks from fixture transcript')
  const over = drafted.filter((s) => textLength(s.content) > MAX_SECTION_CHARS).length
  console.log(`chunks=${drafted.length} over_${MAX_SECTION_CHARS}=${over}`)

  const values: number[][] = []
  for (let i = 0; i < drafted.length; i += EMBED_BATCH) {
    const slice = drafted.slice(i, i + EMBED_BATCH)
    const vecs = await embedTexts(slice.map((s) => s.content))
    if (!vecs || vecs.length !== slice.length) {
      throw new Error(`embed failed at offset ${i}: got ${vecs?.length ?? 0}`)
    }
    for (const v of vecs) values.push(l2normalize(v))
    console.log(`  embedded ${values.length}/${drafted.length}`)
  }

  const dims = values[0]?.length ?? 0
  const index: LocalSectionIndex = {
    model: LOCAL_EMBED_MODEL,
    dims,
    minCosine: 0.45,
    sourceFile: FIXTURE,
    builtAt: new Date().toISOString(),
    vectors: drafted.map((metadata, i) => ({
      id: String(metadata.section_id),
      values: values[i] ?? [],
      metadata,
    })),
  }
  mkdirSync(path.dirname(LOCAL_SECTION_INDEX_PATH), { recursive: true })
  writeFileSync(LOCAL_SECTION_INDEX_PATH, JSON.stringify(index))
  console.log(`wrote ${LOCAL_SECTION_INDEX_PATH} dims=${dims} n=${index.vectors.length}`)
  console.log(
    'NOTE: local qwen3-embedding:0.6b is 1024-dim; production uses @cf/google/embeddinggemma-300m at 768-dim. Not bit-comparable.',
  )
  return index
}

const thisFile = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (thisFile.endsWith('build-local-section-index.ts')) {
  buildLocalSectionIndex().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
