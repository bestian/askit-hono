// R2 答案快取（issue #25）：對「相同問題（且影響答案的參數也相同）」的回應做 7 天快取。
// 收到問題時先簡單確認快取是否存在，命中就直接取用，不再跑檢索與 AI。
//
// 三條路徑各自獨立命名空間（key 前綴），避免互相污染：
//   - /ask/      → scope 'ask'（HTML）
//   - /cag/、/cag → scope 'cag'（markdown，含參數）
//   - /webhook   → scope 'webhook'（JSON：answer + sources）
//
// 任一情況下 bucket 未綁（dev／測試）或讀寫發生錯誤時都「優雅降級」：當作未命中、
// 照常生成，絕不讓快取問題阻斷正常回答。

/** 快取範圍，對應 issue 要求區分的三條路徑。 */
export type CacheScope = 'ask' | 'cag' | 'webhook'

/** 快取壽命：7 天。 */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 命中且物件已超過 3.5 天時，重寫同一 key 以刷新 R2 物件壽命。 */
export const CACHE_REFRESH_AFTER_MS = CACHE_TTL_MS / 2

export type CachedEntry = {
  body: string
  contentType: string
  shouldRefresh: boolean
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 正規化問題：壓縮空白、去前後空白、轉小寫，讓「實質相同」的問題命中同一筆快取。
function normalizeQuestion(question: string): string {
  return question.replace(/\s+/g, ' ').trim().toLowerCase()
}

// 由 scope + 正規化問題 + 影響答案的參數，組出穩定的快取 key。
// 參數先過濾掉 undefined/null，再依鍵名排序序列化，確保「同組參數、順序無關」對應同一 key。
export async function buildCacheKey(
  scope: CacheScope,
  question: string,
  params: Record<string, unknown> = {},
): Promise<string> {
  const serializedParams = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join('&')
  const hash = await sha256Hex(`${normalizeQuestion(question)}|${serializedParams}`)
  return `cache/${scope}/${hash}`
}

// 讀取快取。命中且未過期回傳內容；未綁 bucket、查無、過期或發生錯誤一律回 null（視為未命中）。
// 7 天壽命以 R2 物件的上傳時間判斷；過期順手刪除，避免 bucket 無限膨脹。
// 命中但已超過 3.5 天時標記 shouldRefresh，讓呼叫端可用 waitUntil 背景續命。
export async function getCachedResponse(
  bucket: R2Bucket | undefined,
  key: string,
): Promise<CachedEntry | null> {
  if (!bucket) return null
  try {
    const object = await bucket.get(key)
    if (!object) return null
    const ageMs = Date.now() - object.uploaded.getTime()
    if (ageMs > CACHE_TTL_MS) {
      await bucket.delete(key).catch(() => {})
      return null
    }
    const body = await object.text()
    const contentType = object.httpMetadata?.contentType || 'text/plain; charset=UTF-8'
    return { body, contentType, shouldRefresh: ageMs > CACHE_REFRESH_AFTER_MS }
  } catch (e) {
    console.error('快取讀取失敗，視為未命中:', e)
    return null
  }
}

// 寫入快取。未綁 bucket 直接略過；寫入失敗只記錄、不拋出（不影響已回給使用者的答案）。
export async function putCachedResponse(
  bucket: R2Bucket | undefined,
  key: string,
  body: string,
  contentType: string,
): Promise<void> {
  if (!bucket) return
  try {
    await bucket.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: { cachedAt: String(Date.now()) },
    })
  } catch (e) {
    console.error('快取寫入失敗，略過:', e)
  }
}

// 快取命中續命：只在 getCachedResponse 標記 shouldRefresh 時重寫同一份內容，
// 刷新 R2 uploaded time，讓熱 key 不會被 7 天 lifecycle 刪除。
export async function refreshCachedResponse(
  bucket: R2Bucket | undefined,
  key: string,
  cached: CachedEntry,
): Promise<void> {
  if (!cached.shouldRefresh) return
  await putCachedResponse(bucket, key, cached.body, cached.contentType)
}
