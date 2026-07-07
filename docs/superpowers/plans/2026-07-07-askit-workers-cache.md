# Askit-Hono Workers Cache Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Cloudflare's new front-of-Worker Workers Cache for `askit-hono` as a Tier 1 edge cache, keeping the hand-rolled R2 `ASK_CACHE` as the Tier 2 persistent semantic cache.

**Architecture:** Upgrade Wrangler to `^4.107.0` and bump `compatibility_date` to `2026-07-07` in `wrangler.jsonc`. Enable `"cache": { "enabled": true }`. Fix CORS helper in `@au/cf-ai-gateway` to always append `Vary: Origin` even for denied/absent origins. Update `/au/:question` and `/cag/:question` response paths in `src/index.ts` to attach `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` on successful cacheable responses, and `Cache-Control: private, no-store` on cache bypass/refresh requests.

**Tech Stack:** Cloudflare Workers, TypeScript, Hono, Node.js Test Runner

## Global Constraints
- Do not use `: any` or `as any` (enforce type safety).
- Do not bypass question normalization for R2 cache; Workers Cache only caches raw URLs as a front layer.

---

### Task 1: Update Toolchain and Config

**Files:**
- Modify: `../askit-hono/package.json`
- Modify: `../askit-hono/wrangler.jsonc`

- [ ] **Step 1: Upgrade wrangler in package.json**
Run: `npm install -D wrangler@latest` inside `../askit-hono`.
Expected: Installs `wrangler@4.107.0` or higher.

- [ ] **Step 2: Enable cache and update compatibility_date in wrangler.jsonc**
Modify `compatibility_date` to `"2026-07-07"` and add `"cache": { "enabled": true }` to `wrangler.jsonc`.

- [ ] **Step 3: Run wrangler types to verify config**
Run: `npm run cf-typegen` inside `../askit-hono`.
Expected: Generates project types without warnings about unexpected fields.

---

### Task 2: Fix CORS Vary: Origin Header for Denied/Absent Origins

**Files:**
- Modify: `../askit-hono/packages/cf-ai-gateway/src/askCors.ts`

- [ ] **Step 1: Always append Vary: Origin in createAskCors.apply**
Modify `apply` in `packages/cf-ai-gateway/src/askCors.ts` to append `Vary: Origin` first, and return the modified response if the origin is absent or denied.
```typescript
  function apply(request: Request, response: Response): Response {
    const origin = request.headers.get('Origin') ?? undefined
    const headers = new Headers(response.headers)
    appendVary(headers, 'Origin')

    if (!isAllowedOrigin(origin)) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }

    headers.set('Access-Control-Allow-Origin', origin!)
    headers.set('Access-Control-Allow-Methods', allowedMethods)
    headers.set('Access-Control-Allow-Headers', allowedHeaders)
    headers.set('Access-Control-Max-Age', maxAgeSeconds)

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
```

---

### Task 3: Implement Cache-Control Headers on AI Endpoints

**Files:**
- Modify: `../askit-hono/src/index.ts`

- [ ] **Step 1: Update respondFromCache to set Cache-Control**
Update `respondFromCache` (around line 237) to set `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`.
```typescript
function respondFromCache(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  })
}
```

- [ ] **Step 2: Update cacheCagResponse to set Cache-Control**
Update `cacheCagResponse` (around line 433) to set `Cache-Control` dynamically: `public, max-age=3600, stale-while-revalidate=86400` for cacheable GETs, and `private, no-store` when `cacheKey` is null (refresh requests).
```typescript
function cacheCagResponse(
  c: Context<{ Bindings: Bindings }>,
  cacheKey: string | null,
  response: Response,
): Response {
  if (response.status !== 200 || !response.body) return response
  const [toClient, toCache] = response.body.tee()
  const headers = new Headers(response.headers)
  if (cacheKey) {
    const contentType =
      response.headers.get('Content-Type') || 'text/markdown; charset=UTF-8'
    headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
    c.executionCtx.waitUntil(
      readStreamToString(toCache)
        .then((text) => {
          if (!isCacheableCagAnswerText(text)) return
          return putCachedResponse(c.env.ASK_CACHE, cacheKey, text, contentType)
        })
        .catch((e) => console.error('快取串流寫入失敗:', e)),
    )
  } else {
    toCache.cancel().catch(() => {})
    headers.set('Cache-Control', 'private, no-store')
  }
  return new Response(toClient, {
    status: response.status,
    headers,
  })
}
```

---

### Task 4: Verification

- [ ] **Step 1: Run typecheck**
Run: `npm run typecheck` inside `../askit-hono`.
Expected: PASS

- [ ] **Step 2: Run test suite**
Run: `npm run test` inside `../askit-hono`.
Expected: PASS
