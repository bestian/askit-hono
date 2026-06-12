import assert from 'node:assert/strict'
import test from 'node:test'

import { hydrateCagSourcesFromArchive } from '../src/utils/cag'
import {
  countSentences,
  DEFAULT_MIN_ANSWER_CHARS,
  DEFAULT_MIN_GROUNDING_SCORE,
  groundingScoreForAnswer,
  isShallowAnswer,
  scoreCagDepth,
  scoreCagAnswer,
} from '../src/utils/cagEval'

test('countSentences counts Chinese and Western sentence enders', () => {
  assert.equal(countSentences('第一句。第二句！Third?'), 3)
  assert.equal(countSentences(''), 0)
})

test('groundingScoreForAnswer rewards overlap with cited source text', () => {
  const score = groundingScoreForAnswer(
    '地神香火是地方信仰的一部分，相關說明見 [1]。',
    ['地神香火是地方信仰的重要組成，廟宇會準備供品。'],
  )
  assert.ok(score > 0.2)
})

test('scoreCagDepth marks shallow when binary pass but answer is too short', () => {
  const sources = [{ content: '地神香火是地方信仰的重要組成，廟宇會準備供品與鮮花。' }]
  const answer = '地神香火是地方信仰的一部分，相關說明可參考來源 [1]。'
  const binary = scoreCagAnswer(answer, 1, { requireTraditionalChinese: true })
  const depth = scoreCagDepth(answer, sources, binary.citedIndexes, {
    binaryPassed: binary.passed,
    minAnswerChars: DEFAULT_MIN_ANSWER_CHARS,
    minGroundingScore: DEFAULT_MIN_GROUNDING_SCORE,
  })
  assert.equal(binary.passed, true)
  assert.ok(depth.answerChars < DEFAULT_MIN_ANSWER_CHARS)
  assert.equal(depth.shallow, true)
})

test('scoreCagDepth marks deep when answer is substantive and grounded', () => {
  const sources = [{
    content:
      '地神香火是地方信仰的重要組成，廟宇會準備供品與鮮花，' +
      '社區也會在節慶時共同維護廟宇環境與祭祀秩序，' +
      '也透過長期參與讓在地文化得以延續。',
  }]
  const answer =
    '地神香火是地方信仰的重要組成，廟宇會準備供品與鮮花，' +
    '社區也會在節慶時共同維護廟宇環境與祭祀秩序，' +
    '也透過長期參與讓在地文化得以延續並維持社群連結，' +
    '讓傳統信仰與當代生活能夠彼此照應 [1]。'
  const binary = scoreCagAnswer(answer, 1, { requireTraditionalChinese: true })
  const depth = scoreCagDepth(answer, sources, binary.citedIndexes, {
    binaryPassed: binary.passed,
  })
  assert.equal(binary.passed, true)
  assert.ok(depth.answerChars >= DEFAULT_MIN_ANSWER_CHARS)
  assert.ok(depth.groundingScore >= DEFAULT_MIN_GROUNDING_SCORE)
  assert.equal(depth.shallow, false)
  assert.equal(isShallowAnswer(true, depth), false)
})

test('hydrateCagSourcesFromArchive expands section content from archive API', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/section/123') {
      return Response.json({
        section_id: 123,
        section_content: '<p>中段內容包含較完整的段落資訊</p>',
        previous_content: '<p>前段內容包含較完整的段落資訊</p>',
        next_content: '<p>後段內容包含較完整的段落資訊</p>',
        display_name: '示範會議',
        name: '唐鳳',
      })
    }
    return new Response('not found', { status: 404 })
  }

  try {
    const hydrated = await hydrateCagSourcesFromArchive('https://archive.tw', [{
      content: '<p>短片段</p>',
      href: 'https://archive.tw/demo#s123',
      label: '示範 — 唐鳳',
      sectionId: 123,
    }])
    assert.equal(hydrated.length, 1)
    assert.match(hydrated[0].content, /前段內容/)
    assert.match(hydrated[0].content, /中段內容/)
    assert.match(hydrated[0].content, /後段內容/)
    assert.ok(hydrated[0].content.length > 30)
  } finally {
    globalThis.fetch = originalFetch
  }
})