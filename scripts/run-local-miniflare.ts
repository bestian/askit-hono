/**
 * Boot the 鳳問 Worker locally with zero Cloudflare contact.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/run-local-miniflare.ts
 *
 * Builds local/section-index.json if missing, starts Miniflare,
 * then GET /cag/資料土壤 and prints status + body. Pass --serve to keep
 * listening. No CLOUDFLARE_* / --remote.
 *
 * Bindings:
 *   real-but-local: KV CAG_CACHE, D1 ABUSE_DB + SAYIT_DB, DO RATE_LIMIT_DO,
 *                   RATE_LIMITER, vars
 *   shimmed:        AI (Ollama embed + local chat), VECTORIZE (cosine index)
 *   bypassed:       ASK_CACHE, ASK_INDEX (R2 remote:true), Workers AI,
 *                   production Vectorize
 *
 * Embeddings: qwen3-embedding:0.6b @ 1024-dim — NOT bit-comparable to
 * production @cf/google/embeddinggemma-300m @ 768-dim.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { Miniflare } from 'miniflare'

import {
  LOCAL_CHAT_MODEL,
  LOCAL_CHAT_URL,
  LOCAL_EMBED_MODEL,
  LOCAL_EMBED_URL,
  embedTexts,
} from '../src/utils/cagMemories'
import {
  LOCAL_SECTION_INDEX_PATH,
  buildLocalSectionIndex,
  loadLocalSectionIndex,
  queryLocalSectionIndex,
  type LocalSectionIndex,
} from './build-local-section-index'

const PORT = Number(process.env.LOCAL_MINIFLARE_PORT ?? '8788')
const HOST = process.env.LOCAL_MINIFLARE_HOST ?? '127.0.0.1'
const QUESTION = process.env.LOCAL_CAG_QUESTION ?? '資料土壤'

function stripCloudflareEnv(): string[] {
  const removed: string[] = []
  for (const key of Object.keys(process.env)) {
    if (
      /^(CLOUDFLARE_|WRANGLER_|CF_API|CF_AIG|CF_AI_GATEWAY)/.test(key)
      || key === 'CLOUDFLARE_API_TOKEN'
      || key === 'CLOUDFLARE_ACCOUNT_ID'
    ) {
      delete process.env[key]
      removed.push(key)
    }
  }
  return removed
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) })
    return res.ok || res.status === 405 || res.status === 404
  } catch {
    return false
  }
}

async function probeHosts(): Promise<{ ollama: boolean; chat: boolean }> {
  const ollama = await probe(new URL('/api/tags', LOCAL_EMBED_URL).href)
  const chat = await probe(new URL('/v1/models', LOCAL_CHAT_URL).href)
  console.log(`probe ollama ${LOCAL_EMBED_URL} → ${ollama ? 'up' : 'DOWN'}`)
  console.log(`probe chat   ${LOCAL_CHAT_URL} → ${chat ? 'up' : 'DOWN'}`)
  return { ollama, chat }
}

function assemblePrompt(input: Record<string, unknown>): string {
  const messages = input.messages
  if (!Array.isArray(messages)) return JSON.stringify(input)
  return messages
    .map((m) => {
      const rec = m as { role?: string; content?: string }
      return `${rec.role ?? 'user'}:\n${rec.content ?? ''}`
    })
    .join('\n\n')
}

function isEmbedCall(model: string, input: Record<string, unknown>): boolean {
  if (/embed/i.test(model)) return true
  const text = input.text
  return Array.isArray(text) && text.every((t) => typeof t === 'string')
}

/** Drop EmbeddingGemma prefixes so qwen3-embedding scores stay in the same space as the local index. */
function stripGemmaPrefix(text: string): string {
  const query = text.match(/^task:\s*search result\s*\|\s*query:\s*/i)
  if (query) return text.slice(query[0].length)
  const doc = text.match(/^title:\s*none\s*\|\s*text:\s*/i)
  if (doc) return text.slice(doc[0].length)
  return text
}

async function handleLocalAi(
  chatUp: { current: boolean },
  request: Request,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== '/run' || request.method !== 'POST') {
    return new Response('not found', { status: 404 })
  }
  const body = (await request.json()) as { model?: string; input?: Record<string, unknown> }
  const model = body.model ?? ''
  const input = body.input ?? {}
  if (isEmbedCall(model, input)) {
    const texts = Array.isArray(input.text)
      ? (input.text as unknown[]).map((t) => stripGemmaPrefix(String(t)))
      : typeof input.text === 'string'
        ? [stripGemmaPrefix(input.text)]
        : []
    const vecs = await embedTexts(texts)
    if (!vecs) return Response.json({ data: [] })
    return Response.json({ data: vecs })
  }

  const prompt = assemblePrompt(input)
  if (!chatUp.current) {
    return Response.json({
      response: `[local chat down @ ${LOCAL_CHAT_URL}; returning assembled prompt]\n\n${prompt}`,
    })
  }
  const maxTokens = typeof input.max_completion_tokens === 'number'
    ? input.max_completion_tokens
    : 512
  try {
    const res = await fetch(LOCAL_CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: LOCAL_CHAT_MODEL,
        messages: input.messages ?? [{ role: 'user', content: prompt }],
        max_tokens: Math.min(maxTokens, 1024),
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      chatUp.current = false
      const err = await res.text()
      return Response.json({
        response: `[local chat HTTP ${res.status}: ${err.slice(0, 200)}]\n\n${prompt}`,
      })
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = json.choices?.[0]?.message?.content ?? ''
    return Response.json({ response: text || prompt })
  } catch (e) {
    chatUp.current = false
    return Response.json({
      response: `[local chat error: ${e instanceof Error ? e.message : String(e)}]\n\n${prompt}`,
    })
  }
}

function handleLocalVec(index: LocalSectionIndex, request: Request): Promise<Response> {
  return request.json().then((body) => {
    const rec = body as {
      vector?: number[]
      options?: { topK?: number; returnMetadata?: 'none' | 'indexed' | 'all' }
    }
    const vector = Array.isArray(rec.vector) ? rec.vector : []
    return Response.json(queryLocalSectionIndex(index, vector, rec.options))
  })
}

async function bundleWorkerEntry(): Promise<string> {
  const require = createRequire(import.meta.url)
  const esbuild = require('esbuild') as typeof import('esbuild')
  const outfile = path.join(os.tmpdir(), 'askit-local-worker.mjs')
  await esbuild.build({
    entryPoints: [path.resolve('scripts/local-worker-entry.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['workerd', 'browser', 'module', 'main'],
    keepNames: true,
    logLevel: 'warning',
  })
  return outfile
}

async function main(): Promise<void> {
  const serve = process.argv.includes('--serve')
  const stripped = stripCloudflareEnv()
  if (stripped.length > 0) {
    console.log(`stripped credentials from env: ${stripped.join(', ')}`)
  } else {
    console.log('no Cloudflare credentials in env')
  }

  const hosts = await probeHosts()
  if (!hosts.ollama) {
    throw new Error(`Ollama not reachable at ${LOCAL_EMBED_URL} — cannot embed or retrieve`)
  }

  if (!existsSync(LOCAL_SECTION_INDEX_PATH)) {
    console.log('local/section-index.json missing — building…')
    await buildLocalSectionIndex()
  }
  const index = loadLocalSectionIndex()
  console.log(`index n=${index.vectors.length} dims=${index.dims} model=${index.model}`)

  const chatUp = { current: hosts.chat }
  const scriptPath = await bundleWorkerEntry()
  console.log(`bundled worker → ${scriptPath}`)

  const mf = new Miniflare({
    name: 'askit-local',
    compatibilityDate: '2026-05-07',
    compatibilityFlags: ['nodejs_compat'],
    modules: true,
    scriptPath,
    modulesRoot: path.dirname(scriptPath),
    host: HOST,
    port: PORT,
    bindings: {
      CAG_RETRIEVER: 'vectorize',
      ASK_ARCHIVE_BASE_URL: 'http://127.0.0.1:9',
      GLOBAL_GENERATION_LIMIT_PER_MINUTE: '30',
      GLOBAL_GENERATION_LIMIT_PER_DAY: '1000',
      ABUSE_BLACKLIST_THRESHOLD: '3',
      ABUSE_COUNT_WINDOW_HOURS: '24',
      AUDREY_MODEL: 'nemotron-ultra',
    },
    kvNamespaces: ['CAG_CACHE'],
    d1Databases: ['ABUSE_DB', 'SAYIT_DB'],
    durableObjects: {
      RATE_LIMIT_DO: { className: 'RateLimiterDO', useSQLite: true },
    },
    ratelimits: {
      RATE_LIMITER: { simple: { limit: 15, period: 10 } },
    },
    serviceBindings: {
      LOCAL_AI: (request: Request) => handleLocalAi(chatUp, request),
      LOCAL_VEC: (request: Request) => handleLocalVec(index, request),
    },
  })

  const url = `http://${HOST}:${PORT}/cag/${encodeURIComponent(QUESTION)}`
  console.log(`GET ${url}`)
  const res = await mf.dispatchFetch(url)
  const body = await res.text()
  console.log(`HTTP ${res.status}`)
  console.log(body)
  console.log('---')
  console.log(`embedder: ${LOCAL_EMBED_MODEL} (1024-dim) — not bit-comparable to production EmbeddingGemma-300m (768-dim)`)
  console.log('outbound hosts this process may contact:')
  console.log(`  ${LOCAL_EMBED_URL} (Ollama embed)`)
  console.log(`  ${LOCAL_CHAT_URL} (deepseek-v4-flash) — ${chatUp.current ? 'used' : 'skipped / down'}`)
  console.log('  http://127.0.0.1:9 (ASK_ARCHIVE_BASE_URL hydrate stub; expected fail → thin metadata)')
  console.log('no Cloudflare hosts, no --remote, ASK_CACHE unbound (cache miss).')

  if (serve) {
    console.log(`listening on http://${HOST}:${PORT}  (Ctrl-C to stop)`)
    await new Promise(() => {})
  } else {
    await mf.dispose()
  }
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
