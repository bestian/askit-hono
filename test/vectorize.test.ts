import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDocumentEmbeddingInput,
  buildQueryEmbeddingInput,
  extractEmbedding,
  extractEmbeddings,
  retrieveCagSourcesFromVectorize,
  vectorMetadataToCagSource,
  type VectorizeBinding,
} from '../src/utils/vectorize'

test('embedding inputs use EmbeddingGemma task prefixes', () => {
  assert.equal(buildQueryEmbeddingInput('地神香火'), 'task: search result | query: 地神香火')
  assert.equal(buildDocumentEmbeddingInput('某段逐字稿'), 'title: none | text: 某段逐字稿')
})

test('extractEmbeddings handles REST, binding, and raw shapes', () => {
  // REST API：{ result: { data: [[...]] } }
  assert.deepEqual(extractEmbeddings({ result: { data: [[1, 2, 3]] } }), [[1, 2, 3]])
  // binding：{ data: [[...]] }
  assert.deepEqual(extractEmbeddings({ data: [[4, 5]] }), [[4, 5]])
  // 直接二維陣列
  assert.deepEqual(extractEmbeddings([[6, 7]]), [[6, 7]])
  // 單一向量（一維）→ 包成一筆
  assert.deepEqual(extractEmbeddings([8, 9]), [[8, 9]])
  // 取第一筆
  assert.deepEqual(extractEmbedding({ data: [[1], [2]] }), [1])
  assert.equal(extractEmbedding({}), null)
})

test('vectorMetadataToCagSource builds CagSource from metadata', () => {
  const source = vectorMetadataToCagSource({
    section_id: 123,
    filename: '2024-01-01-demo',
    content: '<p>某段內容</p>',
    display_name: '2024-01-01 示範會議',
    speaker: '唐鳳',
  })
  assert.ok(source)
  assert.equal(source?.href, 'https://archive.tw/2024-01-01-demo#s123')
  assert.equal(source?.label, '2024-01-01 示範會議 — 唐鳳')
  assert.equal(source?.content, '<p>某段內容</p>')
  assert.equal(source?.sectionId, 123)
})

test('vectorMetadataToCagSource rejects incomplete metadata', () => {
  assert.equal(vectorMetadataToCagSource(null), null)
  assert.equal(vectorMetadataToCagSource({ filename: 'x', content: 'y' }), null) // 缺 section_id
  assert.equal(vectorMetadataToCagSource({ section_id: 1, content: 'y' }), null) // 缺 filename
})

test('retrieveCagSourcesFromVectorize embeds query, queries index, maps + dedups', async () => {
  const aiCalls: { model: string; input: Record<string, unknown> }[] = []
  const ai = {
    run: async (model: string, input: Record<string, unknown>) => {
      aiCalls.push({ model, input })
      return { data: [[0.1, 0.2, 0.3]] }
    },
  }

  let queriedVector: number[] | null = null
  const vectorize: VectorizeBinding = {
    query: async (vector, options) => {
      queriedVector = vector
      assert.equal(options?.returnMetadata, 'all')
      return {
        matches: [
          {
            id: '123',
            score: 0.9,
            metadata: {
              section_id: 123,
              filename: '2024-01-01-demo',
              content: '甲段',
              display_name: '示範會議',
              speaker: '唐鳳',
            },
          },
          // 重複 section_id → 應被去重
          {
            id: '123',
            score: 0.8,
            metadata: {
              section_id: 123,
              filename: '2024-01-01-demo',
              content: '甲段',
              display_name: '示範會議',
              speaker: '唐鳳',
            },
          },
          {
            id: '456',
            score: 0.7,
            metadata: {
              section_id: 456,
              filename: '2024-02-02-demo',
              content: '乙段',
              display_name: '另一會議',
            },
          },
        ],
      }
    },
  }

  const sources = await retrieveCagSourcesFromVectorize(ai, vectorize, '某個問題', { topK: 6 })

  assert.equal(aiCalls.length, 1)
  assert.equal(aiCalls[0].model, '@cf/google/embeddinggemma-300m')
  assert.deepEqual(aiCalls[0].input.text, ['task: search result | query: 某個問題'])
  assert.deepEqual(queriedVector, [0.1, 0.2, 0.3])

  assert.equal(sources.length, 2) // 去重後
  assert.equal(sources[0].sectionId, 123)
  assert.equal(sources[0].href, 'https://archive.tw/2024-01-01-demo#s123')
  assert.equal(sources[1].sectionId, 456)
  assert.equal(sources[1].label, '另一會議') // 無 speaker
})

test('retrieveCagSourcesFromVectorize returns [] on embed/query failure or empty', async () => {
  const okAi = { run: async () => ({ data: [[1, 2]] }) }

  // 查詢拋錯 → []
  const throwingVectorize: VectorizeBinding = {
    query: async () => {
      throw new Error('boom')
    },
  }
  assert.deepEqual(
    await retrieveCagSourcesFromVectorize(okAi, throwingVectorize, 'q'),
    [],
  )

  // 嵌入回空 → []（不應呼叫 query）
  const emptyAi = { run: async () => ({ data: [] }) }
  let queried = false
  const vectorize: VectorizeBinding = {
    query: async () => {
      queried = true
      return { matches: [] }
    },
  }
  assert.deepEqual(await retrieveCagSourcesFromVectorize(emptyAi, vectorize, 'q'), [])
  assert.equal(queried, false)

  // 空問句 → []
  assert.deepEqual(await retrieveCagSourcesFromVectorize(okAi, vectorize, '   '), [])
})
