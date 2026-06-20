import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregate,
  countSeedPhrases,
  detectScript,
  EN_STOPWORDS,
  extractHanNgrams,
  extractLatinNgrams,
  htmlToPlainText,
  SEED_PHRASES,
  topN,
} from '../scripts/voiceMetrics'

test('htmlToPlainText strips tags, decodes entities, collapses whitespace', () => {
  const out = htmlToPlainText('<p>hello&nbsp;&amp;<br>world</p><p>foo&#39;s</p>')
  assert.equal(out, "hello & world foo's")
})

test('htmlToPlainText removes <p> open tags with attributes', () => {
  assert.equal(
    htmlToPlainText('<p class="x">A</p><p data-n="1">B</p>'),
    'A B',
  )
})

test('detectScript returns han for Han text', () => {
  assert.equal(detectScript('「數位民主」'), 'han')
})

test('detectScript returns latin when no Han characters present', () => {
  assert.equal(detectScript('"broad listening"'), 'latin')
  assert.equal(detectScript('123 !@#'), 'latin')
})

test('extractHanNgrams never spans non-Han separators', () => {
  const grams = extractHanNgrams('民主自由,人權', [2])
  assert.equal(grams.get('民主'), 1)
  assert.equal(grams.get('自由'), 1)
  assert.equal(grams.get('人權'), 1)
  // cross-comma gram must not exist
  assert.equal(grams.get('由人'), undefined)
  // interior slide within the 4-char run
  assert.equal(grams.get('主自'), 1)
})

test('extractHanNgrams counts repeated grams', () => {
  const grams = extractHanNgrams('民主民主', [2])
  assert.equal(grams.get('民主'), 2)
})

test('countSeedPhrases counts non-overlapping occurrences', () => {
  const counts = countSeedPhrases('我覺得其實我覺得', ['我覺得'])
  assert.equal(counts.get('我覺得'), 2)
})

test('countSeedPhrases skips empty seeds and missing seeds', () => {
  const counts = countSeedPhrases('abc', ['', 'xy'])
  assert.equal(counts.get(''), undefined)
  assert.equal(counts.get('xy'), 0)
})

test('topN orders by count desc then gram asc, respects n', () => {
  const map = new Map<string, number>([
    ['a', 3],
    ['b', 1],
    ['c', 3],
    ['d', 2],
  ])
  const out = topN(map, 3)
  assert.deepEqual(out, [
    { gram: 'a', count: 3 },
    { gram: 'c', count: 3 },
    { gram: 'd', count: 2 },
  ])
})

test('topN drops zero-count entries', () => {
  const map = new Map<string, number>([
    ['x', 0],
    ['y', 2],
  ])
  assert.deepEqual(topN(map, 5), [{ gram: 'y', count: 2 }])
})

test('extractLatinNgrams lowercases and drops stopwords', () => {
  const grams = extractLatinNgrams(
    'I think broad listening is SO important',
    [2],
  )
  assert.ok(grams.has('broad listening'))
  // stopword-only bigrams must be absent
  assert.equal(grams.get('is so'), undefined)
  // 'so' is a stopword, so 'so important' is correctly filtered out
  assert.equal(grams.get('so important'), undefined)
  // case-insensitivity: SO lowercased (check via default sizes which include unigrams)
  const uni = extractLatinNgrams('I think broad listening is SO important')
  assert.ok(uni.has('important'))
  // 'so' is a stopword even when lowercased from 'SO' — proves lowercasing + filtering
  assert.equal(uni.get('so'), undefined)
})

test('extractLatinNgrams normalizes typographic apostrophes so contractions stay one token', () => {
  const grams = extractLatinNgrams('there\u2019s don\u2019t', [1, 2])
  assert.equal(grams.get("there's"), 1)
  assert.equal(grams.get("don't"), 1)
  assert.equal(grams.get("there's don't"), 1)
  // the split-by-curly-quote artifact must not appear
  assert.equal(grams.get('there s'), undefined)
  assert.equal(grams.get('don t'), undefined)
})

test('extractLatinNgrams default sizes include unigrams, bigrams, trigrams', () => {
  const grams = extractLatinNgrams('plurality plurality', [1, 2, 3])
  assert.equal(grams.get('plurality'), 2)
  assert.equal(grams.get('plurality plurality'), 1)
})

test('SEED_PHRASES has zh and en lists', () => {
  assert.ok(SEED_PHRASES.zh.length > 10)
  assert.ok(SEED_PHRASES.en.length > 5)
  assert.ok(SEED_PHRASES.zh.includes('我覺得'))
  assert.ok(SEED_PHRASES.en.includes('broad listening'))
})

test('EN_STOPWORDS includes common function words', () => {
  assert.ok(EN_STOPWORDS.has('the'))
  assert.ok(EN_STOPWORDS.has('is'))
  assert.ok(EN_STOPWORDS.has('would'))
  // content words are not stopwords
  assert.equal(EN_STOPWORDS.has('democracy'), false)
})

test('aggregate routes Han rows to zh counters and Latin rows to en counters', () => {
  const metrics = aggregate(
    [
      {
        filename: '2023-01-01-talk.md',
        section_id: 1,
        section_content: '<p>我覺得民主其實就是很好</p>',
      },
      {
        filename: '2023-06-01-talk-en.md',
        section_id: 2,
        section_content: '<p>I think broad listening is important</p>',
      },
    ],
    {
      topN: 5,
      sample: 5,
      now: () => new Date('2024-01-01T00:00:00Z'),
    },
  )
  assert.equal(metrics.corpus.speeches, 2)
  assert.equal(metrics.corpus.audreySections, 2)
  assert.equal(metrics.corpus.dateRange.from, '2023-01-01')
  assert.equal(metrics.corpus.dateRange.to, '2023-06-01')
  assert.equal(metrics.generatedAt, '2024-01-01T00:00:00.000Z')
  // zh seed counted from the Han row
  const zhFelt = metrics.seedPhrases.zh.find((s) => s.phrase === '我覺得')
  assert.ok(zhFelt && zhFelt.count === 1)
  // en seed counted from the Latin row
  const enThink = metrics.seedPhrases.en.find((s) => s.phrase === 'i think')
  assert.ok(enThink && enThink.count === 1)
  // Han n-grams present, Latin n-grams present
  assert.ok(metrics.hanNgrams.length > 0)
  assert.ok(metrics.latinNgrams.some((g) => g.gram === 'broad listening'))
})

test('aggregate picks openings (min section_id) and closings (max) per speech', () => {
  const metrics = aggregate(
    [
      {
        filename: '2022-01-01-speech.md',
        section_id: 10,
        section_content: '<p>opening remark 我覺得</p>',
      },
      {
        filename: '2022-01-01-speech.md',
        section_id: 3,
        section_content: '<p>真正開頭 就像</p>',
      },
      {
        filename: '2022-01-01-speech.md',
        section_id: 20,
        section_content: '<p>closing remark 譬如</p>',
      },
    ],
    { topN: 5, sample: 5, now: () => new Date('2024-01-01T00:00:00Z') },
  )
  assert.equal(metrics.corpus.speeches, 1)
  // opening = min section_id (3), closing = max (20)
  assert.equal(metrics.openings[0]?.sectionId, 3)
  assert.equal(metrics.closings[0]?.sectionId, 20)
  assert.match(metrics.openings[0]?.text ?? '', /開頭/)
  assert.match(metrics.closings[0]?.text ?? '', /closing/)
})

test('aggregate surfaces analogies longest-first', () => {
  const metrics = aggregate(
    [
      {
        filename: '2023-03-01-x.md',
        section_id: 1,
        section_content: `<p>${'短'.repeat(5)}就像一個比喻</p>`,
      },
      {
        filename: '2023-03-02-y.md',
        section_id: 1,
        section_content: `<p>${'長'.repeat(50)}譬如說這是一個很長的段落來描述想像</p>`,
      },
    ],
    { topN: 5, sample: 5, now: () => new Date('2024-01-01T00:00:00Z') },
  )
  assert.ok(metrics.analogies.length >= 2)
  // longest-first
  assert.ok(
    (metrics.analogies[0]?.text.length ?? 0) >=
      (metrics.analogies[1]?.text.length ?? 0),
  )
  // href shape
  assert.match(
    metrics.analogies[0]?.href ?? '',
    /^https:\/\/archive\.tw\/.+#s\d+$/,
  )
})

test('aggregate href encodes the filename', () => {
  const metrics = aggregate(
    [
      {
        filename: '2023-01-01 檔案.md',
        section_id: 7,
        section_content: '<p>hello 就像</p>',
      },
    ],
    { topN: 5, sample: 5, now: () => new Date('2024-01-01T00:00:00Z') },
  )
  assert.equal(
    metrics.analogies[0]?.href,
    'https://archive.tw/2023-01-01%20%E6%AA%94%E6%A1%88.md#s7',
  )
})
