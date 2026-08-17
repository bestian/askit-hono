import assert from 'node:assert/strict'
import test from 'node:test'

import {
  archiveCanonicalSlug,
  archiveSectionHref,
  archiveSlugCandidates,
  isDegenerateRanking,
  recall,
  type CagEvidence,
  type CagMemory,
  type CagStore,
  type RankedMemory,
} from '../src/utils/cagMemories'

function ev(quote: string): CagEvidence[] {
  return [
    {
      file: 'room.md',
      turnIndex: 0,
      speaker: '唐鳳',
      startChar: 0,
      endChar: quote.length,
      quote,
    },
  ]
}

function mem(partial: Pick<CagMemory, 'id' | 'content'> & Partial<CagMemory>): CagMemory {
  return {
    extractKey: `${partial.id}#audrey#0`,
    phase: 'audrey',
    category: 'fact',
    importance: 4,
    entities: [],
    tags: [],
    roomId: 'room.md',
    roomDate: '2026-07-01',
    sourceFile: 'room.md',
    evidence: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...partial,
  }
}

function scored(score: number, id = `s-${score}`): RankedMemory {
  return { ...mem({ id, content: id }), score }
}

/** English multi-word query whose rarest Latin token is `vtaiwan`. */
const ENGLISH_PARTIAL_QUERY = 'Does vTaiwan teach consensus'

/**
 * Fillers raise DF on `teach` / `consensus` so `vtaiwan` is uniquely rarest.
 * The target memory has only that rare token — the old all-token conjunction
 * scored it 0 (the 60/60-empty English incident).
 */
function englishPartialStore(): CagStore {
  return {
    memories: [
      mem({
        id: 'vtaiwan-only',
        content: 'vTaiwan assembled a facilitated process for live issues.',
      }),
      mem({ id: 'teach-1', content: 'Teachers teach facilitation in workshops.' }),
      mem({ id: 'teach-2', content: 'They teach listening before they decide.' }),
      mem({ id: 'teach-3', content: 'Facilitators teach the room to wait.' }),
      mem({ id: 'consensus-1', content: 'Rough consensus and running code.' }),
      mem({ id: 'consensus-2', content: 'Consensus here is a practice, not a vote.' }),
      mem({ id: 'consensus-3', content: 'Stacked consensus blocks a minority veto.' }),
    ],
    links: [],
  }
}

function englishDifferentiatedStore(): CagStore {
  const base = englishPartialStore()
  return {
    memories: [
      ...base.memories,
      mem({
        id: 'vtaiwan-full',
        content: 'vTaiwan teach consensus through a public agenda and live minutes.',
      }),
    ],
    links: [],
  }
}

/** Same fillers, but the rarest token `vtaiwan` is absent from the corpus. */
function englishAbsentRarestStore(): CagStore {
  return {
    memories: englishPartialStore().memories.filter((m) => m.id !== 'vtaiwan-only'),
    links: [],
  }
}

/** No query token occurs anywhere — the genuine out-of-archive case. */
function englishAllAbsentStore(): CagStore {
  return {
    memories: [
      mem({ id: 'unrelated-1', content: 'The room agreed on a schedule for lunch.' }),
      mem({ id: 'unrelated-2', content: 'Minutes were published the next morning.' }),
      mem({ id: 'unrelated-3', content: 'A facilitator drew the agenda on paper.' }),
    ],
    links: [],
  }
}

/**
 * `vtaiwan` is absent but both common tokens are present, and one memory carries BOTH.
 * This is the measured 38-of-60 incident: one incidental word (`chaotic`, `essays`,
 * `horse`) used to zero every memory because df 0 maximises IDF.
 */
function englishAbsentIncidentalStore(): CagStore {
  return {
    memories: [
      ...englishAbsentRarestStore().memories,
      mem({ id: 'both-present', content: 'They teach consensus in the workshop.' }),
    ],
    links: [],
  }
}

/** Eight audrey memories that share only the Latin token `AI` — the Khmer incident. */
function khmerAiTieStore(): CagStore {
  const quote = 'AI 人才培育與前瞻數位基礎建設'
  return {
    memories: Array.from({ length: 8 }, (_, i) =>
      mem({
        id: `ai-tie-${i}`,
        content: quote,
        roomId: `room-${i}.md`,
        extractKey: `room-${i}.md#audrey#0`,
        evidence: ev(quote),
      }),
    ),
    links: [],
  }
}

test('rarest-token rule recovers multi-word English query that was 60/60 empty', () => {
  const store = englishPartialStore()
  const target = store.memories.find((m) => m.id === 'vtaiwan-only')
  assert.ok(target)
  assert.ok(!/teach|consensus/i.test(target.content))
  const hit = recall(ENGLISH_PARTIAL_QUERY, store)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.ok(hit.memories.length >= 1, dump)
  const found = hit.memories.find((m) => m.id === 'vtaiwan-only')
  assert.ok(found, dump)
  assert.ok(found.score > 0, dump)
})

test('all Latin tokens corpus-absent abstains', () => {
  const store = englishAllAbsentStore()
  for (const token of ['vtaiwan', 'teach', 'consensus']) {
    assert.ok(
      store.memories.every((m) => !m.content.toLowerCase().includes(token)),
      `fixture must not contain ${token}`,
    )
  }
  const hit = recall(ENGLISH_PARTIAL_QUERY, store)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score })))
  assert.equal(hit.memories.length, 0, dump)
  assert.equal(hit.evidence.length, 0, dump)
})

test('one corpus-absent incidental token still zeroes a query — the measured abstention tradeoff', () => {
  // 38 of 60 real English audience questions carry a token absent from the corpus
  // (`chaotic`, `essays`, `horse`), and a df-0 token has maximal IDF, so it becomes the
  // mandatory one and nothing can satisfy it. Two relaxations were implemented and
  // measured: restricting the mandatory pick to df > 0 dropped out-of-archive abstention
  // 15/15 -> 13/15, and additionally dropping absent terms from the coverage denominator
  // dropped it to 9/15 while recovering 60 natural questions. Both were reverted.
  //
  // This test pins the CURRENT cost, deliberately. If you change it, you MUST re-run
  // scripts/measure-gate-fix.ts and keep out-of-archive abstention at 15/15.
  const store = englishAbsentIncidentalStore()
  assert.ok(
    store.memories.some((m) => /teach consensus/i.test(m.content)),
    'fixture must contain a memory carrying both present tokens',
  )
  assert.ok(
    store.memories.every((m) => !/vtaiwan/i.test(m.content)),
    'vtaiwan must be absent from this fixture',
  )
  const hit = recall(ENGLISH_PARTIAL_QUERY, store)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score })))
  assert.equal(hit.memories.length, 0, dump)
})

test('isDegenerateRanking true for >=2 identical scores; false for singleton, empty, or distinct', () => {
  assert.equal(isDegenerateRanking([scored(5.4144, 'a'), scored(5.4144, 'b')]), true)
  assert.equal(
    isDegenerateRanking([scored(1, 'a'), scored(1, 'b'), scored(1, 'c')]),
    true,
  )
  assert.equal(isDegenerateRanking([scored(1, 'only')]), false)
  assert.equal(isDegenerateRanking([]), false)
  assert.equal(isDegenerateRanking([scored(1, 'a'), scored(2, 'b')]), false)
  // Tolerance-sized delta must still count as a tie (epsilon, not ===).
  const tied = 5.4144
  const epsilonDelta = 1e-12
  assert.notEqual(tied, tied + epsilonDelta)
  assert.equal(
    isDegenerateRanking([scored(tied, 'a'), scored(tied + epsilonDelta, 'b')]),
    true,
  )
  assert.equal(
    isDegenerateRanking([scored(1, 'a'), scored(1 + 1e-3, 'b')]),
    false,
  )
})

test('identically-scored recall results must still return memories (no tie-based abstention)', () => {
  const store = khmerAiTieStore()
  assert.equal(store.memories.length, 8)
  const hit = recall('តើ AI នឹងផ្លាស់ប្តូរការងារយើងដូចម្តេច?', store)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score })))
  assert.ok(hit.memories.length > 0, dump)
  assert.ok(hit.evidence.length > 0, dump)
  assert.equal(isDegenerateRanking(hit.memories), true, dump)
})

test('non-degenerate differentiated scores still return memories', () => {
  const store = englishDifferentiatedStore()
  const hit = recall(ENGLISH_PARTIAL_QUERY, store)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.ok(hit.memories.length >= 1, dump)
  assert.equal(isDegenerateRanking(hit.memories), false, dump)
  if (hit.memories.length >= 2) {
    const scores = hit.memories.map((m) => m.score)
    assert.ok(Math.max(...scores) - Math.min(...scores) > 1e-3, dump)
  }
  assert.ok(
    hit.memories.some((m) => m.id === 'vtaiwan-full' || m.id === 'vtaiwan-only'),
    dump,
  )
})

test('archiveCanonicalSlug lowercases Latin, leaves folded input, deletes CJK punctuation', () => {
  assert.equal(
    archiveCanonicalSlug('2026-07-16-Open-Commons-專訪'),
    '2026-07-16-open-commons-專訪',
  )
  const alreadyFolded = '2026-07-16-open-commons-專訪'
  assert.equal(archiveCanonicalSlug(alreadyFolded), alreadyFolded)
  const withPunct = '2026-07-16-座談：「開放」'
  const folded = archiveCanonicalSlug(withPunct)
  assert.equal(folded, '2026-07-16-座談開放')
  assert.ok(!folded.includes('：「'))
  assert.ok(!folded.includes('「'))
  assert.ok(!folded.includes('」'))
  assert.ok(!folded.includes('座談-開放'), folded)
  assert.ok(!folded.includes('-開放'), folded)
})

test('archiveSlugCandidates is most-specific-first, deduped, contains input, at most 3', () => {
  const openCommons = '2026-07-16-Open-Commons-專訪'
  const openCands = archiveSlugCandidates(openCommons)
  assert.ok(openCands.includes(openCommons))
  assert.ok(openCands.includes('2026-07-16-open-commons-專訪'))
  assert.equal(openCands[0], openCommons)
  assert.equal(new Set(openCands).size, openCands.length)
  assert.ok(openCands.length <= 3)
  assert.ok(openCands.length >= 1)

  const punct = '2026-07-16-Open-Commons：「專訪」'
  const punctCands = archiveSlugCandidates(punct)
  assert.deepEqual(punctCands, [
    '2026-07-16-Open-Commons：「專訪」',
    '2026-07-16-open-commons：「專訪」',
    '2026-07-16-open-commons專訪',
  ])
  assert.ok(punctCands.includes(punct))
  assert.equal(new Set(punctCands).size, punctCands.length)
  assert.ok(punctCands.length <= 3)

  const plain = '2026-07-16-open-commons'
  const plainCands = archiveSlugCandidates(plain)
  assert.deepEqual(plainCands, [plain])
  assert.ok(plainCands.includes(plain))
  assert.ok(plainCands.length <= 3)
})

test('archiveSectionHref applies the canonical slug fold', () => {
  assert.equal(
    archiveSectionHref('2026-07-16-Open-Commons-專訪', 12),
    'https://archive.tw/2026-07-16-open-commons-專訪#s12',
  )
  assert.equal(
    archiveSectionHref('2026-07-16-Open-Commons：「專訪」', 3),
    'https://archive.tw/2026-07-16-open-commons專訪#s3',
  )
  assert.equal(
    archiveSectionHref('2026-07-16-open-commons', 1),
    'https://archive.tw/2026-07-16-open-commons#s1',
  )
})
