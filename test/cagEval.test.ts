import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAG_MODEL_GEMMA,
  estimateCagRequestCostUsd,
  evalMeetsThreshold,
  extractCitationIndexes,
  looksTraditionalChinese,
  scoreCagAnswer,
} from '../src/utils/cagEval'

test('extractCitationIndexes finds bracket and footnote citations', () => {
  assert.deepEqual(extractCitationIndexes('根據 [1] 與 [^2] 的內容'), [1, 2])
  assert.deepEqual(extractCitationIndexes('來源 [2, 3, 4] 與 [6]'), [2, 3, 4, 6])
})

test('scoreCagAnswer passes well-formed cited zh-TW answers', () => {
  const score = scoreCagAnswer(
    '地神香火是地方信仰的一部分，相關說明見 [1]。',
    3,
    { requireTraditionalChinese: true, minCitations: 1 },
  )
  assert.equal(score.passed, true)
  assert.deepEqual(score.citedIndexes, [1])
})

test('scoreCagAnswer fails invalid citation indexes', () => {
  const score = scoreCagAnswer('引用 [9] 的說法', 2)
  assert.equal(score.passed, false)
  assert.equal(score.checks.validCitationIndexes, false)
})

test('looksTraditionalChinese rejects common simplified markers', () => {
  assert.equal(looksTraditionalChinese('这是中国的政策'), false)
  assert.equal(looksTraditionalChinese('這是臺灣的開源軟體政策'), true)
})

test('estimateCagRequestCostUsd returns a positive Gemma estimate', () => {
  const gemma = estimateCagRequestCostUsd(CAG_MODEL_GEMMA)!
  assert.ok(gemma > 0)
})

test('evalMeetsThreshold enforces 90% pass ratio', () => {
  assert.equal(evalMeetsThreshold(9, 10), true)
  assert.equal(evalMeetsThreshold(8, 10), false)
})