/**
 * 共用的 Vectorize（語意檢索）常數與工具。
 * Shared constants + helpers for the Cloudflare Vectorize semantic retrieval path.
 *
 * 本檔同時被 runtime Worker 與近端腳本（scripts/vectorize-sync.ts）引用，
 * 故「純函式 / 常數」不可依賴任何 Worker 全域物件；Worker 專用的型別僅以
 * 結構型別（structural typing）描述，編譯後會被抹除。
 */
import type { CagSource } from './cag'
import { buildArchiveTwSectionHref } from './search'

// ── 模型與索引設定（建立索引後 dimensions/metric 不可更改）─────────────────
// EmbeddingGemma-300m：原生 768 維、L2-normalized → 用 cosine。
// Native 768-dim, L2-normalized embeddings → cosine distance.
export const EMBEDDING_MODEL = '@cf/google/embeddinggemma-300m'
export const EMBEDDING_DIM = 768
export const VECTORIZE_METRIC = 'cosine'
/** 預設 Vectorize 索引名稱（≤64 bytes）。可由腳本／binding 覆寫。 */
export const VECTORIZE_INDEX_NAME = 'askit-audrey-tang'

const DEFAULT_TOP_K = 4
const MAX_TOP_K = 12
export const DEFAULT_VECTORIZE_MIN_COSINE_SCORE = 0.45

// ── EmbeddingGemma 任務前綴（Workers AI 端點不會自動加，需自行前綴）─────────
// 文件端：title: none | text: {content}
// 查詢端：task: search result | query: {content}
// 兩端前綴一致才能讓查詢向量與文件向量落在同一語意空間，否則召回率會下降。
export function buildDocumentEmbeddingInput(plainText: string): string {
  return `title: none | text: ${plainText}`
}

export function buildQueryEmbeddingInput(question: string): string {
  return `task: search result | query: ${question}`
}

// ── 每個向量附帶的 metadata（runtime 直接據此組出 CagSource，不必再打 D1/archive）──
// metadata 大小上限 10 KiB/vector；sync 腳本會把 content 截斷在安全範圍內，
// 完整內容由 runtime 的 section API hydrate 補齊。
// key 不可為空、含 "."／'"'、或以 $ 開頭 → 以下命名皆安全。
export type VectorizeSectionMetadata = {
  section_id: number
  filename: string
  /** 巢狀逐字稿檔名；無則省略此 key（Vectorize metadata 不存 null）。 */
  nest_filename?: string
  /** 原始 section_content（可能含 HTML，runtime 會再 htmlToPlainText）。 */
  content: string
  display_name: string
  /** 講者名稱；無則省略此 key。 */
  speaker?: string
}

type WorkersAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>
}

export type VectorizeMatch = {
  id: string
  score: number
  metadata?: Record<string, unknown> | null
}

export type VectorizeQueryResult = {
  matches: VectorizeMatch[]
}

/** Worker 的 Vectorize binding（結構型別，避免綁定特定 workers-types 版本）。 */
export type VectorizeBinding = {
  query: (
    vector: number[],
    options?: {
      topK?: number
      returnMetadata?: 'none' | 'indexed' | 'all'
      returnValues?: boolean
      namespace?: string
      filter?: Record<string, unknown>
    },
  ) => Promise<VectorizeQueryResult>
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function normalizeMinScore(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_VECTORIZE_MIN_COSINE_SCORE
  return Math.max(0, Math.min(1, value))
}

/**
 * 從 Workers AI 嵌入回應抽出向量陣列。
 * 支援以下形狀（REST 與 binding 回傳可能不同）：
 *   { result: { data: number[][], shape } }   ← REST API
 *   { data: number[][], shape }               ← env.AI.run binding
 *   number[][]                                ← 少數情況直接回陣列
 */
export function extractEmbeddings(result: unknown): number[][] {
  if (Array.isArray(result)) {
    if (result.length > 0 && Array.isArray(result[0])) return result as number[][]
    if (result.length > 0 && typeof result[0] === 'number') return [result as number[]]
    return []
  }
  if (!result || typeof result !== 'object') return []
  const obj = result as Record<string, unknown>
  const data = obj.data ?? (obj.result as Record<string, unknown> | undefined)?.data
  if (Array.isArray(data)) {
    if (data.length === 0) return []
    if (Array.isArray(data[0])) return data as number[][]
    if (typeof data[0] === 'number') return [data as number[]]
  }
  return []
}

/** 取第一個向量；查詢時一次只嵌入一段。 */
export function extractEmbedding(result: unknown): number[] | null {
  const all = extractEmbeddings(result)
  return all.length > 0 ? all[0] : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 把 Vectorize match 的 metadata 還原成 CagSource。資料不全則回 null。 */
export function vectorMetadataToCagSource(
  metadata: Record<string, unknown> | null | undefined,
): CagSource | null {
  if (!metadata) return null
  const filename = asString(metadata.filename)
  const content = asString(metadata.content)
  const sectionIdRaw = metadata.section_id
  const sectionId =
    typeof sectionIdRaw === 'number'
      ? sectionIdRaw
      : typeof sectionIdRaw === 'string' && sectionIdRaw.trim() !== ''
        ? Number(sectionIdRaw)
        : null
  if (!filename || !content || sectionId === null || !Number.isFinite(sectionId)) {
    return null
  }

  const nestFilename = asString(metadata.nest_filename)
  const displayName = asString(metadata.display_name) ?? filename
  const speaker = asString(metadata.speaker)
  const href = buildArchiveTwSectionHref(filename, sectionId, nestFilename)
  const label = speaker ? `${displayName} — ${speaker}` : displayName
  return { content, href, label, sectionId }
}

/**
 * 語意檢索：嵌入問句 → 查 Vectorize → 還原成 CagSource[]。
 * 任一步失敗或無結果都回空陣列，讓上層自行決定是否回退 archive 檢索。
 */
export async function retrieveCagSourcesFromVectorize(
  ai: WorkersAiBinding,
  vectorize: VectorizeBinding,
  question: string,
  options?: { topK?: number; minScore?: number },
): Promise<CagSource[]> {
  const topK = clampInteger(options?.topK ?? DEFAULT_TOP_K, 1, MAX_TOP_K)
  const minScore = normalizeMinScore(options?.minScore)
  const trimmed = question.trim()
  if (trimmed === '') return []

  let embedding: number[] | null = null
  try {
    const result = await ai.run(EMBEDDING_MODEL, {
      text: [buildQueryEmbeddingInput(trimmed)],
    })
    embedding = extractEmbedding(result)
  } catch (e) {
    console.error('Vectorize 查詢嵌入失敗:', e)
    return []
  }
  if (!embedding || embedding.length === 0) return []

  let matches: VectorizeMatch[] = []
  try {
    const queryResult = await vectorize.query(embedding, {
      topK,
      returnMetadata: 'all',
    })
    matches = Array.isArray(queryResult?.matches) ? queryResult.matches : []
  } catch (e) {
    console.error('Vectorize 查詢失敗:', e)
    return []
  }

  const seen = new Set<number>()
  const sources: CagSource[] = []
  for (const match of matches) {
    if (!Number.isFinite(match.score) || match.score < minScore) continue
    const source = vectorMetadataToCagSource(match.metadata)
    if (!source || source.sectionId === null) continue
    if (seen.has(source.sectionId)) continue
    seen.add(source.sectionId)
    sources.push(source)
    if (sources.length >= topK) break
  }
  return sources
}
