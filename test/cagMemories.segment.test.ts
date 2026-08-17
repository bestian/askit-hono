import assert from 'node:assert/strict'
import test from 'node:test'

import { segmenterLocaleFor, segmentQueryContentTerms } from '../src/utils/cagMemories'

/** Measured empty-recall phrasing: 26/40 natural questions returned nothing. */
const CHIPS_AND_STRENGTH_QUERY = '有嗎？我們有這一個籌碼、實力？'

/**
 * Real English function words, which a stop list CAN drop. The original version of this
 * test asserted that `blah` was dropped from 'blah blah AI blah'; that is unsatisfiable,
 * because `blah` is a well-formed word and no segmenter can know it carries no topic.
 * What the measurement actually showed is that unmatchable tokens inflate `queryW` — the
 * fix is a stop list plus a content-word filter, not nonsense detection.
 */
const STOPWORD_AI_QUERY = 'what is the role of AI in the classroom'

test('segmenterLocaleFor routes kana to ja, hangul to ko, and defaults CJK/English to zh-TW', () => {
  assert.equal(
    segmenterLocaleFor('マスクマップはどのように作られたのですか？'),
    'ja',
  )
  assert.equal(segmenterLocaleFor('마스크 지도는 어떻게 만들어졌나요?'), 'ko')
  assert.equal(segmenterLocaleFor('口罩地圖是怎麼做出來的？'), 'zh-TW')
  assert.equal(segmenterLocaleFor('How was the mask map built in Taiwan?'), 'zh-TW')
})

test('26/40 empty natural questions: 有嗎？我們有這一個籌碼、實力？ keeps 籌碼 and 實力, drops 有/嗎/我們', () => {
  const terms = segmentQueryContentTerms(CHIPS_AND_STRENGTH_QUERY)
  const dump = JSON.stringify(terms)
  assert.ok(terms.includes('籌碼'), dump)
  assert.ok(terms.includes('實力'), dump)
  assert.ok(!terms.includes('有'), dump)
  assert.ok(!terms.includes('嗎'), dump)
  assert.ok(!terms.includes('我們'), dump)
})

test('function words are dropped while the topical token survives', () => {
  const terms = segmentQueryContentTerms(STOPWORD_AI_QUERY)
  const dump = JSON.stringify(terms)
  assert.ok(
    terms.some((t) => t.toLowerCase() === 'ai'),
    `expected the topical token to survive: ${dump}`,
  )
  for (const stop of ['the', 'is', 'of', 'in']) {
    assert.ok(
      terms.every((t) => t.toLowerCase() !== stop),
      `expected function word "${stop}" to be dropped: ${dump}`,
    )
  }
  assert.ok(
    terms.some((t) => t.toLowerCase() === 'role' || t.toLowerCase() === 'classroom'),
    `expected a content word to survive: ${dump}`,
  )
})

test('segmentQueryContentTerms is deterministic, deduped, and empty-safe', () => {
  const first = segmentQueryContentTerms(CHIPS_AND_STRENGTH_QUERY)
  const second = segmentQueryContentTerms(CHIPS_AND_STRENGTH_QUERY)
  const dump = JSON.stringify({ first, second })
  assert.ok(first.length > 0, dump)
  assert.deepEqual(first, second)

  const repeated = segmentQueryContentTerms('籌碼、籌碼、實力、實力')
  const repeatedDump = JSON.stringify(repeated)
  assert.ok(repeated.length > 0, repeatedDump)
  assert.equal(new Set(repeated).size, repeated.length, repeatedDump)
  assert.ok(repeated.includes('籌碼'), repeatedDump)
  assert.ok(repeated.includes('實力'), repeatedDump)

  assert.deepEqual(segmentQueryContentTerms(''), [])
})

test('CJK topic term of length >= 2 survives (40/40 natural questions retain one)', () => {
  const terms = segmentQueryContentTerms('口罩地圖跟開放政府是怎麼開始的？')
  const dump = JSON.stringify(terms)
  assert.ok(terms.length > 0, dump)
  assert.ok(
    terms.some((t) => t.length >= 2),
    dump,
  )
  assert.ok(
    terms.some((t) => t.includes('口罩') || t.includes('地圖') || t.includes('開放') || t.includes('政府')),
    dump,
  )
})
