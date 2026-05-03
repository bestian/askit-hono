import type Fuse from 'fuse.js'
import {
  ASK_INDEX_R2_KEY,
  type AskIndexPayload,
  type SectionRow,
  createAskFuseFromPayload,
} from './askIndexFormat'

export type AskSearchResult = {
  content: string
  filename: string
  nest_filename: string | null
  section_id: number
  display_name: string
  section_speaker: string | null
}

type LoadedIndex = {
  fuse: Fuse<SectionRow>
  rowCount: number
  generatedAt: string
}

/**
 * Module-level cache：同個 Worker isolate 在多次請求間共用解析後的 Fuse index。
 * 鍵為 R2 key，因此換不同講者索引時可以共存。
 */
const indexCache = new Map<string, Promise<LoadedIndex>>()

async function loadIndexFromR2(
  bucket: R2Bucket,
  key: string,
): Promise<LoadedIndex> {
  const obj = await bucket.get(key)
  if (!obj) {
    throw new Error(`找不到 R2 物件：${key}（請先執行 npm run build:index）`)
  }
  const text = await obj.text()
  const payload = JSON.parse(text) as AskIndexPayload
  const fuse = createAskFuseFromPayload(payload)
  return {
    fuse,
    rowCount: payload.rowCount,
    generatedAt: payload.generatedAt,
  }
}

async function getIndex(bucket: R2Bucket, key: string): Promise<LoadedIndex> {
  const cached = indexCache.get(key)
  if (cached) return cached

  const promise = loadIndexFromR2(bucket, key).catch((e) => {
    indexCache.delete(key)
    throw e
  })
  indexCache.set(key, promise)
  return promise
}

function rowToResult(row: SectionRow): AskSearchResult {
  return {
    content: row.section_content ?? '',
    filename: row.filename,
    nest_filename: row.nest_filename,
    section_id: Number(row.section_id),
    display_name: row.display_name ?? row.filename,
    section_speaker: row.section_speaker,
  }
}

/**
 * 從 R2 預先建好的 Fuse index 找最相近的段落。
 * 索引由 `npm run build:index` 從 D1 sections view 預先產出並上傳。
 */
export async function findClosestMatchingSection(
  bucket: R2Bucket,
  question: string,
  options?: {
    r2Key?: string
  },
): Promise<AskSearchResult | null> {
  const key = options?.r2Key ?? ASK_INDEX_R2_KEY
  const q = question.trim()
  if (q === '') return null

  const { fuse, rowCount } = await getIndex(bucket, key)
  if (rowCount === 0) return null

  const hits = fuse.search(q, { limit: 1 })
  const top = hits[0]
  if (!top) return null
  return rowToResult(top.item)
}

export function buildArchiveTwSectionHref(
  filename: string,
  sectionId: number,
  nestFilename: string | null | undefined,
): string {
  const enc = encodeURIComponent
  const path = nestFilename
    ? `${enc(filename)}/${enc(nestFilename)}`
    : enc(filename)
  return `https://archive.tw/${path}#s${sectionId}`
}

export function escapeHtmlText(s: string): string {
  return s
    .replace(/<p>/g, '\n')
    .replace(/<\/p>/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function htmlToPlainText(s: string): string {
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
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function formatAskAnswerHtml(result: AskSearchResult): string {
  const href = buildArchiveTwSectionHref(
    result.filename,
    result.section_id,
    result.nest_filename,
  )
  return `${escapeHtmlText(result.content)}\n\n出處：<a href="${escapeHtmlText(href)}" target="_blank" rel="noopener noreferrer">${escapeHtmlText(result.display_name)}</a>`
}

export function formatAskAnswerText(
  result: AskSearchResult,
  options?: { maxChars?: number },
): string {
  const href = buildArchiveTwSectionHref(
    result.filename,
    result.section_id,
    result.nest_filename,
  )
  const source = `\n\n出處：${result.display_name}\n${href}`
  const content = htmlToPlainText(result.content)
  const maxChars = options?.maxChars
  if (maxChars === undefined || content.length + source.length <= maxChars) {
    return `${content}${source}`
  }

  const suffix = `...${source}`
  const contentMaxChars = Math.max(0, maxChars - suffix.length)
  return `${content.slice(0, contentMaxChars).trimEnd()}${suffix}`
}
