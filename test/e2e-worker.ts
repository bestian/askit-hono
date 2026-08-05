/**
 * 本機端到端驗證用的 workerd 進入點（不進 production bundle，也不在 npm test 內）。
 *
 * 包住真正的 Hono app，只替換兩個外部相依：
 *   AI        —— 假模型：把 `__answer` 指定的字串切成 SSE chunk 逐段吐出
 *   CAG_CACHE —— 永遠命中的來源快取，繞過 archive.tw 檢索
 *
 * 其餘全是 production 程式碼：路由、middleware、黑名單／限流、答案快取、
 * streamCagAnswer、workersAiEventStreamToText、audreySkillCitationFootnotes、
 * TextEncoderStream，以及 Response 組裝。
 *
 * 用法：
 *   npx wrangler dev --config test/e2e-wrangler.jsonc --port 8788 --ip 127.0.0.1
 *   GET /au/<問題>?__answer=<模型輸出>&__chunk=<每個 SSE chunk 幾個字元>
 *   POST /__transform {"inputs":[...],"chunk":n} —— 在 workerd 內直接跑引註
 *   transform，供與 Node 端輸出逐字比對（runtime 一致性驗證）。
 */
import app from '../src/index'
import type { CagSource } from '../src/utils/cag'
import { audreySkillCitationFootnotes } from '../src/utils/audreySkill'

const SOURCES: CagSource[] = [
  {
    content: '仁工智慧提升社群照顧自己與他人的能力。',
    href: 'https://archive.tw/2026-05-28-demo#s63852758',
    label: '2026-05-28 demo — 唐鳳',
    sectionId: 63852758,
  },
  {
    content: 'AI 在對齊大會中像高級西洋棋鐘。',
    href: 'https://archive.tw/2026-05-28-demo#s63852803',
    label: '2026-05-28 demo — 唐鳳',
    sectionId: 63852803,
  },
]

/** 模仿 Workers AI 的 SSE 串流：每個 chunk 一個 `data:` 事件，最後補 [DONE]。 */
function sseFromAnswer(answer: string, chunkSize: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const parts: string[] = []
  for (let index = 0; index < answer.length; index += chunkSize) {
    parts.push(answer.slice(index, index + chunkSize))
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: part })}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

/** 在 workerd 內直接跑 transform，供與 Node 結果逐字比對（runtime 一致性）。 */
async function runTransformBatch(request: Request): Promise<Response> {
  const { inputs, chunk } = (await request.json()) as { inputs: string[]; chunk: number }
  const outputs: string[] = []
  for (const input of inputs) {
    const stream = audreySkillCitationFootnotes(SOURCES)
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()
    const parts: string[] = []
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
    })()
    for (let i = 0; i < input.length; i += chunk) {
      await writer.write(input.slice(i, i + chunk))
    }
    await writer.close()
    await pump
    outputs.push(parts.join(''))
  }
  return Response.json(outputs)
}

export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/__transform') return runTransformBatch(request)
    const answer = url.searchParams.get('__answer') ?? ''
    const chunkSize = Math.max(1, Number(url.searchParams.get('__chunk') ?? '1') || 1)

    const injected = {
      ...env,
      AI: { run: async () => sseFromAnswer(answer, chunkSize) },
      CAG_CACHE: {
        get: async () => JSON.stringify(SOURCES),
        put: async () => undefined,
      },
    }
    return app.fetch(request, injected as never, ctx)
  },
}
