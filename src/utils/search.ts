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
  rowCount: number
  generatedAt: string
}

const LINE_FLEX_BODY_MAX_CHARS = 280
const LINE_FLEX_ALT_TEXT_MAX_CHARS = 1_500

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

export function normalizeAskSearchQuestion(question: string): string {
  return question
    .replace(/(?:是什麼|什麼是)/g, '')
    .replace(/\p{P}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
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
