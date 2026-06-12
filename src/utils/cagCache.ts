import type { CagRetriever, CagSource } from './cag'

/** Retrieved sources TTL — fresh enough for transcript drift without hammering archive.tw. */
export const CAG_SOURCE_CACHE_TTL_SECONDS = 3_600

export type CagSourceCacheParams = {
  question: string
  topK: number
  retriever: CagRetriever
  archiveBaseUrl?: string
  vectorizeMinScore?: number
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function normalizeQuestion(question: string): string {
  return question.replace(/\s+/g, ' ').trim().toLowerCase()
}

export async function buildCagSourceCacheKey(params: CagSourceCacheParams): Promise<string> {
  const serializedParams = Object.keys(params)
    .filter((key) => key !== 'question')
    .filter((key) => {
      const value = params[key as keyof CagSourceCacheParams]
      return value !== undefined && value !== null && value !== ''
    })
    .sort()
    .map((key) => {
      const value = params[key as keyof CagSourceCacheParams]
      return `${key}=${String(value)}`
    })
    .join('&')
  const hash = await sha256Hex(`${normalizeQuestion(params.question)}|${serializedParams}`)
  return `cag:src:${hash}`
}

function isCagSource(value: unknown): value is CagSource {
  if (!value || typeof value !== 'object') return false
  const source = value as Record<string, unknown>
  return (
    typeof source.content === 'string'
    && typeof source.href === 'string'
    && typeof source.label === 'string'
    && (source.sectionId === null || typeof source.sectionId === 'number')
  )
}

export async function getCachedCagSources(
  kv: KVNamespace | undefined,
  key: string,
): Promise<CagSource[] | null> {
  if (!kv) return null
  try {
    const raw = await kv.get(key, 'text')
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || !parsed.every(isCagSource)) return null
    return parsed
  } catch (e) {
    console.error('CAG 來源快取讀取失敗，視為未命中:', e)
    return null
  }
}

export async function putCachedCagSources(
  kv: KVNamespace | undefined,
  key: string,
  sources: CagSource[],
): Promise<void> {
  if (!kv || sources.length === 0) return
  try {
    await kv.put(key, JSON.stringify(sources), {
      expirationTtl: CAG_SOURCE_CACHE_TTL_SECONDS,
    })
  } catch (e) {
    console.error('CAG 來源快取寫入失敗，略過:', e)
  }
}