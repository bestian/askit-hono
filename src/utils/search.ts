import type Fuse from 'fuse.js'
import type { CagSource } from './cag'
import {
  ASK_INDEX_R2_KEY,
  manifestKeyForIndexKey,
  type AskIndexManifest,
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
  name: string | null
}

type LineTextMessage = {
  type: 'text'
  text: string
}

type LineFlexMessage = {
  type: 'flex'
  altText: string
  contents: Record<string, unknown>
}

export type LineReplyMessage = LineTextMessage | LineFlexMessage

type LoadedIndex = {
  fuse: Fuse<SectionRow>
  rows: SectionRow[]
  rowCount: number
  generatedAt: string
  indexKey: string
  indexSha256: string | null
}

const LINE_FLEX_BODY_MAX_CHARS = 280
const LINE_FLEX_ALT_TEXT_MAX_CHARS = 1_500
const LINE_CAG_BODY_MAX_CHARS = 1_200
const INDEX_MANIFEST_CHECK_MS = 60_000

/**
 * Module-level cache：同個 Worker isolate 在多次請求間共用解析後的 Fuse index。
 * 鍵為邏輯 R2 key；小 manifest 會定期檢查，變更時重新載入大 index。
 */
type IndexCacheEntry = {
  checkedAt: number
  fingerprint: string
  promise: Promise<LoadedIndex>
}

const indexCache = new Map<string, IndexCacheEntry>()

function fingerprintForIndex(
  indexKey: string,
  manifest: AskIndexManifest | null,
): string {
  if (!manifest) return `static:${indexKey}`
  return [
    'manifest',
    manifest.indexKey,
    manifest.indexSha256,
    manifest.generatedAt,
    manifest.rowCount,
  ].join(':')
}

async function loadManifestFromR2(
  bucket: R2Bucket,
  key: string,
): Promise<AskIndexManifest | null> {
  const obj = await bucket.get(key)
  if (!obj) return null
  return JSON.parse(await obj.text()) as AskIndexManifest
}

async function loadIndexFromR2(
  bucket: R2Bucket,
  key: string,
  manifest: AskIndexManifest | null,
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
    rows: payload.rows,
    rowCount: payload.rowCount,
    generatedAt: payload.generatedAt,
    indexKey: key,
    indexSha256: manifest?.indexSha256 ?? null,
  }
}

async function getIndex(bucket: R2Bucket, key: string): Promise<LoadedIndex> {
  const cached = indexCache.get(key)
  const now = Date.now()
  if (cached && now - cached.checkedAt < INDEX_MANIFEST_CHECK_MS) {
    return cached.promise
  }

  let manifest: AskIndexManifest | null = null
  try {
    manifest = await loadManifestFromR2(bucket, manifestKeyForIndexKey(key))
  } catch (e) {
    console.error('載入索引 manifest 失敗:', e)
    if (cached) {
      cached.checkedAt = now
      return cached.promise
    }
  }

  const indexKey = manifest?.indexKey ?? key
  const fingerprint = fingerprintForIndex(indexKey, manifest)
  if (cached && cached.fingerprint === fingerprint) {
    cached.checkedAt = now
    return cached.promise
  }

  const previous = cached
  const promise = loadIndexFromR2(bucket, indexKey, manifest).catch((e) => {
    if (previous) {
      console.error('重新載入索引失敗，沿用既有 cache:', e)
      previous.checkedAt = now
      indexCache.set(key, previous)
      return previous.promise
    }
    indexCache.delete(key)
    throw e
  })
  indexCache.set(key, { checkedAt: now, fingerprint, promise })
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
    name: row.name,
  }
}

export function normalizeAskSearchQuestion(question: string): string {
  return question
    .replace(/(?:是什麼|什麼是)/g, '')
    .replace(/\p{P}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isRandomAskQuestion(question: string): boolean {
  const q = question.trim().toLowerCase()
  return q === '隨機' || q === '隨機一篇' || q === 'random' || q === 'Random'
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
  const q = normalizeAskSearchQuestion(question)
  if (q === '') return null

  const { fuse, rowCount } = await getIndex(bucket, key)
  if (rowCount === 0) return null

  const hits = fuse.search(q, { limit: 1 })
  const top = hits[0]
  if (!top) return null
  return rowToResult(top.item)
}

export async function findClosestMatchingSections(
  bucket: R2Bucket,
  question: string,
  options?: {
    r2Key?: string
    limit?: number
  },
): Promise<AskSearchResult[]> {
  const key = options?.r2Key ?? ASK_INDEX_R2_KEY
  const limit = Math.max(1, Math.min(16, Math.floor(options?.limit ?? 6)))
  const q = normalizeAskSearchQuestion(question)
  if (q === '') return []

  const { fuse, rowCount } = await getIndex(bucket, key)
  if (rowCount === 0) return []

  const hits = fuse.search(q, { limit: limit * 3 })
  const seen = new Set<string>()
  const results: AskSearchResult[] = []
  for (const hit of hits) {
    const result = rowToResult(hit.item)
    const key = `${result.filename}/${result.nest_filename ?? ''}#${result.section_id}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push(result)
    if (results.length >= limit) break
  }
  return results
}

export async function findRandomSection(
  bucket: R2Bucket,
  options?: {
    r2Key?: string
  },
): Promise<AskSearchResult | null> {
  const key = options?.r2Key ?? ASK_INDEX_R2_KEY
  const { rows } = await getIndex(bucket, key)
  if (rows.length === 0) return null

  const randomIndex = Math.floor(Math.random() * rows.length)
  return rowToResult(rows[randomIndex])
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

export function buildArchiveTwOgImageUrl(
  filename: string,
  nestFilename: string | null | undefined,
): string {
  const enc = encodeURIComponent
  const path = nestFilename
    ? `${enc(filename)}/${enc(nestFilename)}`
    : enc(filename)
  return `https://archive.tw/og/${path}.png`
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

function extractDisplayDate(filename: string): string {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

function removeLeadingDisplayDate(displayName: string): string {
  return displayName.replace(/^\d{4}-\d{2}-\d{2}\s+/, '')
}

function truncatePlainText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return `${s.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function markdownToLinePlainText(s: string): string {
  return s
    .replace(/^\[\^\d+\]:.*$/gm, '')
    .replace(/\[\^(\d+)\]/g, '[$1]')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildArchiveTwOgImageUrlFromHref(href: string): string {
  try {
    const url = new URL(href)
    const path = url.pathname.replace(/^\/+|\/+$/g, '')
    url.pathname = `/og/${path}.png`
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return buildArchiveTwOgImageUrl(href, null)
  }
}

function extractDisplayDateFromHref(href: string): string {
  try {
    const url = new URL(href)
    const decodedPath = decodeURIComponent(url.pathname)
    return extractDisplayDate(decodedPath.replace(/^\/+/, ''))
  } catch {
    return ''
  }
}

function removeSourceSpeaker(label: string): string {
  return removeLeadingDisplayDate(label.split(' — ')[0] ?? label)
}

function askResultToCagSource(result: AskSearchResult): CagSource {
  return {
    content: result.content,
    href: buildArchiveTwSectionHref(
      result.filename,
      result.section_id,
      result.nest_filename,
    ),
    label: result.name
      ? `${result.display_name} — ${result.name}`
      : result.display_name,
    sectionId: result.section_id,
  }
}

function buildFuseAnswerText(results: AskSearchResult[]): string {
  return results
    .map((result, index) => {
      const content = truncatePlainText(htmlToPlainText(result.content), 320)
      return `[${index + 1}] ${content}`
    })
    .join('\n\n')
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

export function formatAskAnswerFlex(result: AskSearchResult): LineReplyMessage {
  const href = buildArchiveTwSectionHref(
    result.filename,
    result.section_id,
    result.nest_filename,
  )
  const imageUrl = buildArchiveTwOgImageUrl(
    result.filename,
    result.nest_filename,
  )
  const content = truncatePlainText(
    htmlToPlainText(result.content),
    LINE_FLEX_BODY_MAX_CHARS,
  )
  const displayDate = extractDisplayDate(result.filename)
  const displaySource = removeLeadingDisplayDate(result.display_name)
  const altText = truncatePlainText(
    `${content}\n\n出處：${displaySource}`,
    LINE_FLEX_ALT_TEXT_MAX_CHARS,
  )

  const details = [
    {
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: '出處',
          color: '#aaaaaa',
          size: 'sm',
          flex: 1,
        },
        {
          type: 'text',
          text: displaySource,
          wrap: true,
          color: '#666666',
          size: 'sm',
          flex: 5,
        },
      ],
    },
  ]

  if (displayDate !== '') {
    details.push({
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: '日期',
          color: '#aaaaaa',
          size: 'sm',
          flex: 1,
        },
        {
          type: 'text',
          text: displayDate,
          wrap: true,
          color: '#666666',
          size: 'sm',
          flex: 5,
        },
      ],
    })
  }

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      hero: {
        type: 'image',
        url: imageUrl,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'fit',
        action: {
          type: 'uri',
          uri: href,
        },
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: content,
            weight: 'bold',
            size: 'md',
            wrap: true,
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            spacing: 'sm',
            contents: details,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'uri',
              label: '前往來源',
              uri: href,
            },
          },
          {
            type: 'box',
            layout: 'vertical',
            contents: [],
            margin: 'sm',
          },
        ],
        flex: 0,
      },
    },
  }
}

export function formatCagAnswerFlex(
  answer: string,
  sources: CagSource[],
): LineReplyMessage {
  const displaySources = sources.slice(0, 2)
  const content = truncatePlainText(
    markdownToLinePlainText(answer),
    LINE_CAG_BODY_MAX_CHARS,
  )

  if (displaySources.length === 0) {
    return { type: 'text', text: content || '找不到符合條件的段落，請上\nhttps://archive.tw' }
  }

  const altText = truncatePlainText(content, LINE_FLEX_ALT_TEXT_MAX_CHARS)
  const sourceColumns = displaySources.map((source, index) => {
    const displaySource = removeSourceSpeaker(source.label)
    const displayDate = extractDisplayDateFromHref(source.href)
    const details = [
      {
        type: 'text',
        text: `出處 ${index + 1}`,
        color: '#aaaaaa',
        size: 'xs',
      },
      {
        type: 'text',
        text: displaySource,
        wrap: true,
        color: '#666666',
        size: 'xs',
        maxLines: 3,
      },
    ]

    if (displayDate !== '') {
      details.push({
        type: 'text',
        text: displayDate,
        wrap: true,
        color: '#999999',
        size: 'xs',
        maxLines: 1,
      })
    }

    return {
      type: 'box',
      layout: 'vertical',
      flex: 1,
      spacing: 'xs',
      paddingAll: 'sm',
      borderColor: '#eeeeee',
      borderWidth: '1px',
      cornerRadius: 'md',
      contents: [
        ...details,
        {
          type: 'button',
          style: 'link',
          height: 'sm',
          action: {
            type: 'uri',
            label: '前往來源',
            uri: source.href,
          },
        },
      ],
    }
  })

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'horizontal',
        contents: displaySources.map((source) => ({
          type: 'image',
          url: buildArchiveTwOgImageUrlFromHref(source.href),
          size: 'full',
          aspectRatio: '1:1',
          aspectMode: 'fit',
          flex: 1,
          action: {
            type: 'uri',
            uri: source.href,
          },
        })),
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: content,
            weight: 'bold',
            size: 'md',
            wrap: true,
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: sourceColumns,
          },
        ],
      },
    },
  }
}

export function formatFuseAnswerFlex(results: AskSearchResult[]): LineReplyMessage {
  return formatCagAnswerFlex(
    buildFuseAnswerText(results.slice(0, 2)),
    results.slice(0, 2).map(askResultToCagSource),
  )
}
