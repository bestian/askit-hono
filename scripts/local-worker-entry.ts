/**
 * Offline Worker entry: import the production Hono app and inject local
 * AI + VECTORIZE shims into env. Does not edit src/index.ts.
 *
 * LOCAL_AI / LOCAL_VEC are Miniflare service bindings implemented in Node
 * (see run-local-miniflare.ts) so workerd never talks to Cloudflare.
 */
import app, { RateLimiterDO } from '../src/index'

export { RateLimiterDO }

type FetcherLike = { fetch: (input: string | URL, init?: RequestInit) => Promise<Response> }

type LocalEnv = Record<string, unknown> & {
  LOCAL_AI?: FetcherLike
  LOCAL_VEC?: FetcherLike
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> }
  VECTORIZE?: {
    query: (
      vector: number[],
      options?: {
        topK?: number
        returnMetadata?: 'none' | 'indexed' | 'all'
        returnValues?: boolean
        namespace?: string
        filter?: Record<string, unknown>
      },
    ) => Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> | null }> }>
  }
}

function createAiShim(env: LocalEnv) {
  return {
    async run(model: string, input: Record<string, unknown>): Promise<unknown> {
      const binding = env.LOCAL_AI
      if (!binding) throw new Error('LOCAL_AI service binding missing')
      const res = await binding.fetch('http://local-ai/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`LOCAL_AI ${res.status}: ${text.slice(0, 400)}`)
      }
      return res.json()
    },
  }
}

function createVectorizeShim(env: LocalEnv) {
  return {
    async query(
      vector: number[],
      options?: {
        topK?: number
        returnMetadata?: 'none' | 'indexed' | 'all'
        returnValues?: boolean
        namespace?: string
        filter?: Record<string, unknown>
      },
    ) {
      const binding = env.LOCAL_VEC
      if (!binding) throw new Error('LOCAL_VEC service binding missing')
      const res = await binding.fetch('http://local-vec/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vector, options }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`LOCAL_VEC ${res.status}: ${text.slice(0, 400)}`)
      }
      return res.json() as Promise<{
        matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> | null }>
      }>
    },
  }
}

export function injectLocalShims(env: LocalEnv): LocalEnv {
  return {
    ...env,
    AI: createAiShim(env),
    VECTORIZE: createVectorizeShim(env),
  }
}

type ExecCtxLike = {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

export default {
  fetch(request: Request, env: LocalEnv, ctx: ExecCtxLike): Response | Promise<Response> {
    return app.fetch(
      request,
      injectLocalShims(env) as typeof env,
      ctx as unknown as Parameters<typeof app.fetch>[2],
    )
  },
}
