import assert from 'node:assert/strict'
import test from 'node:test'

import app from '../src/index'
import {
  buildCagQueryVariants,
  markdownCitationFootnotes,
  normalizeCagOptions,
  parseArchiveSectionId,
  retrieveCagSources,
} from '../src/utils/cag'
import type { VectorizeBinding } from '../src/utils/vectorize'

async function streamToString(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    text += value
  }
}

test('buildCagQueryVariants keeps useful Chinese retrieval terms', () => {
  const variants = buildCagQueryVariants('用 #zh-tw 回答：地神香火如何')
  assert.equal(variants[0], '地神香火如何')
  assert.ok(variants.includes('地神'))
  assert.ok(variants.includes('香火'))
})

test('parseArchiveSectionId extracts archive anchors', () => {
  assert.equal(parseArchiveSectionId('https://archive.tw/a/b#s619731'), 619731)
  assert.equal(parseArchiveSectionId('/demo#s42'), 42)
  assert.equal(parseArchiveSectionId('/demo'), null)
})

test('normalizeCagOptions returns effective parameters used by CAG', () => {
  const options = normalizeCagOptions({
    topK: 999,
    citableTopK: 999,
    maxCompletionTokens: 9999,
    archiveBaseUrl: 'https://archive.tw/',
    retriever: 'vectorize',
    vectorizeMinScore: 2,
  })
  assert.equal(options.topK, 8)
  assert.equal(options.citableTopK, 8)
  assert.equal(options.maxCompletionTokens, 4096)
  assert.equal(options.archiveBaseUrl, 'https://archive.tw')
  assert.equal(options.retriever, 'vectorize')
  assert.equal(options.vectorizeMinScore, 2)

  const minimums = normalizeCagOptions({
    topK: 0,
    citableTopK: 0,
    maxCompletionTokens: 0,
  })
  assert.equal(minimums.topK, 1)
  assert.equal(minimums.citableTopK, 1)
  assert.equal(minimums.maxCompletionTokens, 1)
})

test('public CAG endpoints ignore client-supplied model', async () => {
  const aiCalls: { model: string; input: Record<string, unknown> }[] = []
  const ai = {
    run: async (model: string, input: Record<string, unknown>) => {
      aiCalls.push({ model, input })
      if ('text' in input) return { data: [[0.1, 0.2, 0.3]] }
      return { response: '測試回答 [1]' }
    },
  }
  const vectorize: VectorizeBinding = {
    query: async () => ({
      matches: [
        {
          id: '123',
          score: 0.9,
          metadata: {
            section_id: 123,
            filename: '2024-01-01-demo',
            content: '測試內容',
            display_name: '示範會議',
          },
        },
      ],
    }),
  }
  const env = {
    ASK_MODEL: '@cf/account/allowed-model',
    AI: ai,
    VECTORIZE: vectorize,
    CAG_RETRIEVER: 'vectorize',
  }
  const executionCtx = {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }

  const getResponse = await app.request(
    '/cag/%E6%B8%AC%E8%A9%A6?model=@cf/attacker/expensive-model',
    undefined,
    env,
    executionCtx,
  )
  assert.equal(getResponse.status, 200)
  await getResponse.text()

  const postResponse = await app.request(
    '/cag',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: '測試',
        model: '@cf/attacker/expensive-model',
      }),
    },
    env,
    executionCtx,
  )
  assert.equal(postResponse.status, 200)
  await postResponse.text()

  const chatModels = aiCalls
    .filter(({ input }) => Array.isArray(input.messages))
    .map(({ model }) => model)
  assert.deepEqual(chatModels, [
    '@cf/account/allowed-model',
    '@cf/account/allowed-model',
  ])
})

test('markdownCitationFootnotes rewrites numbered citations and appends used notes', async () => {
  const input = new ReadableStream<string>({
    start(controller) {
      controller.enqueue('A [1] B [99] C [2]')
      controller.close()
    },
  })
  const output = await streamToString(
    input.pipeThrough(markdownCitationFootnotes([
      '[One](https://archive.tw/one#s1)',
      '[Two](https://archive.tw/two#s2)',
    ])),
  )
  assert.equal(
    output,
    'A [^1] B [99] C [^2]\n\n[^1]: [One](https://archive.tw/one#s1)\n[^2]: [Two](https://archive.tw/two#s2)\n',
  )
})

test('retrieveCagSources searches archive and hydrates sections with neighbors', async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    requests.push(url.toString())
    if (url.pathname === '/api/search.json') {
      return Response.json({
        results: [
          {
            title: 'Demo Speech',
            url: '/demo#s123',
            speaker: '唐鳳',
            snippet: '地神',
          },
        ],
      })
    }
    if (url.pathname === '/api/section/123') {
      return Response.json({
        section_id: 123,
        section_content: '<p>中段</p>',
        previous_content: '<p>前段</p>',
        next_content: '<p>後段</p>',
        display_name: 'Demo Speech',
        name: '唐鳳',
      })
    }
    return new Response('not found', { status: 404 })
  }

  try {
    const sources = await retrieveCagSources('地神香火如何', {
      archiveBaseUrl: 'https://archive.tw',
      topK: 2,
    })
    assert.equal(sources.length, 1)
    assert.equal(sources[0].href, 'https://archive.tw/demo#s123')
    assert.equal(sources[0].label, 'Demo Speech — 唐鳳')
    assert.match(sources[0].content, /前段/)
    assert.match(sources[0].content, /中段/)
    assert.match(sources[0].content, /後段/)
    assert.ok(requests.some((url) => url.includes('/api/search.json?q=%E5%9C%B0%E7%A5%9E')))
  } finally {
    globalThis.fetch = originalFetch
  }
})
