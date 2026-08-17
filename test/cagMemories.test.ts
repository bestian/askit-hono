import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  capWindowedMemories,
  clampExtractImportance,
  compactCagStore,
  DEFAULT_MEMORY_MIN_COSINE_SCORE,
  extractHeuristic,
  linkNewMemories,
  loadCagStore,
  memoriesToCagSources,
  mergeCagStores,
  memoryIdForExtractKey,
  isWindowTimeout,
  parseJsonArray,
  parseTranscriptMarkdown,
  recall,
  recallHybrid,
  skippedWindowCheckpoint,
  type CagLink,
  type CagMemory,
} from '../src/utils/cagMemories'

const TRANSCRIPT_CANDIDATES = [
  '/Users/au/w/transcript/2026-06-10-創意官吏獎得獎感言.md',
  path.resolve('test/fixtures/cag-memories/2026-06-10-創意官吏獎得獎感言.md'),
]

function transcriptPath(): string {
  for (const p of TRANSCRIPT_CANDIDATES) {
    if (existsSync(p)) return p
  }
  throw new Error('missing 創意官吏獎 transcript fixture')
}

function loadParsed() {
  const file = transcriptPath()
  return parseTranscriptMarkdown(readFileSync(file, 'utf8'), file)
}

test('parseJsonArray parses a complete array', () => {
  assert.equal(parseJsonArray('[{"a":1}]').length, 1)
})

test('parseJsonArray returns [] for non-json', () => {
  assert.deepEqual(parseJsonArray('not json'), [])
})

test('parseJsonArray returns [] for truncated array without throwing', () => {
  assert.deepEqual(parseJsonArray('[{"a":1},{"b":'), [])
})

test('parse the 創意官吏獎 file into turns (speaker 唐鳳)', () => {
  const parsed = loadParsed()
  assert.ok(parsed.turns.length >= 1)
  assert.ok(parsed.turns.some((t) => /唐鳳/.test(t.speaker)))
  assert.match(parsed.roomDate, /^\d{4}-\d{2}-\d{2}$/)
})

// CheckpointFile.windowsDone is optional (windowed LLM resume); heuristic extract ignores it.
test('--no-llm extract emits observer + audrey with evidence quotes from the file', () => {
  const parsed = loadParsed()
  const markdown = readFileSync(parsed.sourceFile, 'utf8')
  const { memories, links } = extractHeuristic(parsed)
  assert.ok(memories.some((m) => m.phase === 'observer'))
  assert.ok(memories.some((m) => m.phase === 'audrey'))
  for (const mem of memories) {
    assert.ok(mem.evidence.length >= 1)
    for (const ev of mem.evidence) {
      assert.ok(ev.quote.length >= 1)
      assert.ok(markdown.includes(ev.quote.slice(0, Math.min(12, ev.quote.length))))
    }
  }
  const hist: Record<string, number> = {}
  for (const link of links) hist[link.edgeType] = (hist[link.edgeType] ?? 0) + 1
  console.log(
    `fixture extract: memories=${memories.length} links=${links.length} types=${JSON.stringify(hist)}`,
  )
})

test('recall 資料土壤 hits a memory whose content or quote mentions it', () => {
  const parsed = loadParsed()
  const { memories, links } = extractHeuristic(parsed)
  const hit = recall('資料土壤', { memories, links }, { noLlm: true })
  assert.ok(hit.memories.length >= 1)
  assert.ok(hit.memories.some((m) => `${m.content}${m.evidence.map((e) => e.quote).join('')}`.includes('資料土壤')))
})

test('mapper produces CagSource with sectionId null', () => {
  const parsed = loadParsed()
  const { memories } = extractHeuristic(parsed)
  const { cited, background } = memoriesToCagSources(memories, { [parsed.roomId]: parsed.title })
  assert.equal(cited.length, 0)
  assert.ok(background.length >= 1)
  for (const src of background) {
    assert.equal(src.sectionId, null)
    assert.ok(src.href.startsWith('file://'))
    assert.ok(src.label.length > 0)
    assert.ok(src.content.length > 0)
  }
})

test('extractor CLI --no-llm writes jsonl with evidence', () => {
  const file = transcriptPath()
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'cag-mem-'))
  try {
    const npx = path.join(path.dirname(process.execPath), 'npx')
    const run = spawnSync(
      npx,
      [
        'tsx',
        '--tsconfig',
        'scripts/tsconfig.json',
        'scripts/extract-cag-memories.ts',
        '--no-llm',
        '--input',
        file,
        '--out-dir',
        outDir,
        '--max-files',
        '1',
      ],
      { encoding: 'utf8', cwd: path.resolve('.'), shell: false },
    )
    assert.equal(run.status, 0, `${String(run.error ?? '')}\n${run.stderr || run.stdout}`)
    const store = loadCagStore(outDir)
    assert.ok(store.memories.some((m) => m.phase === 'observer'))
    assert.ok(store.memories.some((m) => m.phase === 'audrey'))
    for (const mem of store.memories) assert.ok(mem.evidence.length >= 1)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('extractor CLI refuses to wipe a non-empty store without --resume or --force', () => {
  const file = transcriptPath()
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'cag-mem-'))
  const args = [
    'tsx',
    '--tsconfig',
    'scripts/tsconfig.json',
    'scripts/extract-cag-memories.ts',
    '--no-llm',
    '--input',
    file,
    '--out-dir',
    outDir,
    '--max-files',
    '1',
  ]
  try {
    const npx = path.join(path.dirname(process.execPath), 'npx')
    const first = spawnSync(npx, args, { encoding: 'utf8', cwd: path.resolve('.'), shell: false })
    assert.equal(first.status, 0, `${String(first.error ?? '')}\n${first.stderr || first.stdout}`)
    const firstStore = loadCagStore(outDir)
    assert.ok(firstStore.memories.some((m) => m.phase === 'observer'))
    assert.ok(firstStore.memories.some((m) => m.phase === 'audrey'))
    const jsonlBefore = readFileSync(path.join(outDir, 'memories.jsonl'), 'utf8')
    const second = spawnSync(npx, args, { encoding: 'utf8', cwd: path.resolve('.'), shell: false })
    assert.equal(second.status, 2, `${String(second.error ?? '')}\n${second.stderr || second.stdout}`)
    assert.match(second.stderr, /refusing to wipe non-empty store/)
    const jsonlAfter = readFileSync(path.join(outDir, 'memories.jsonl'), 'utf8')
    assert.equal(jsonlAfter, jsonlBefore)
    const store = loadCagStore(outDir)
    assert.ok(store.memories.some((m) => m.phase === 'observer'))
    assert.ok(store.memories.some((m) => m.phase === 'audrey'))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('loadCagStore last-wins duplicate memory ids and drops orphan links', () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'cag-mem-dedup-'))
  try {
    const jsonl = [
      JSON.stringify({
        kind: 'memory',
        id: 'dup-id',
        extractKey: 'audrey#0',
        roomId: 'room-a',
        phase: 'audrey',
        category: 'insight',
        content: 'content A',
        entities: [],
        importance: 3,
        evidence: [],
      }),
      JSON.stringify({
        kind: 'memory',
        id: 'dup-id',
        extractKey: 'audrey#0',
        roomId: 'room-a',
        phase: 'audrey',
        category: 'insight',
        content: 'content B',
        entities: [],
        importance: 3,
        evidence: [],
      }),
      JSON.stringify({
        kind: 'link',
        sourceId: 'dup-id',
        targetId: 'missing-id',
        edgeType: 'semantic',
        weight: 1,
        why: 'orphan',
      }),
    ].join('\n')
    writeFileSync(path.join(outDir, 'memories.jsonl'), `${jsonl}\n`)
    const store = loadCagStore(outDir)
    assert.equal(store.memories.length, 1)
    assert.equal(store.memories[0]?.id, 'dup-id')
    assert.equal(store.memories[0]?.content, 'content B')
    assert.equal(store.links.length, 0)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('compactCagStore last-wins memories, drops orphan links and stale embeddings', () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'cag-mem-compact-'))
  try {
    const jsonl = [
      JSON.stringify({
        kind: 'memory',
        id: 'dup-id',
        extractKey: 'audrey#0',
        roomId: 'room-a',
        phase: 'audrey',
        category: 'insight',
        content: 'content A',
        entities: [],
        importance: 3,
        evidence: [],
      }),
      JSON.stringify({
        kind: 'memory',
        id: 'dup-id',
        extractKey: 'audrey#0',
        roomId: 'room-a',
        phase: 'audrey',
        category: 'insight',
        content: 'content B',
        entities: [],
        importance: 3,
        evidence: [],
      }),
      JSON.stringify({
        kind: 'link',
        sourceId: 'dup-id',
        targetId: 'missing-id',
        edgeType: 'semantic',
        weight: 1,
        why: 'orphan',
      }),
    ].join('\n')
    writeFileSync(path.join(outDir, 'memories.jsonl'), `${jsonl}\n`)
    writeFileSync(
      path.join(outDir, 'embeddings.jsonl'),
      [
        JSON.stringify({ id: 'dup-id', vector: [1, 0] }),
        JSON.stringify({ id: 'missing-id', vector: [0, 1] }),
      ].join('\n') + '\n',
    )
    const result = compactCagStore(outDir)
    assert.equal(result.memories, 1)
    assert.equal(result.links, 0)
    assert.equal(result.droppedMemoryDupes, 1)
    const store = loadCagStore(outDir)
    assert.equal(store.memories.length, 1)
    assert.equal(store.memories[0]?.content, 'content B')
    assert.equal(store.links.length, 0)
    const rewritten = readFileSync(path.join(outDir, 'memories.jsonl'), 'utf8').trim().split('\n')
    assert.equal(rewritten.length, 1)
    assert.equal(JSON.parse(rewritten[0] ?? '{}').content, 'content B')
    const embeddings = readFileSync(path.join(outDir, 'embeddings.jsonl'), 'utf8').trim().split('\n')
    assert.equal(embeddings.length, 1)
    assert.equal(JSON.parse(embeddings[0] ?? '{}').id, 'dup-id')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

function mem(partial: Pick<CagMemory, 'id' | 'content'> & Partial<CagMemory>): CagMemory {
  return {
    extractKey: `${partial.id}#audrey#0`,
    phase: 'audrey',
    category: 'fact',
    importance: 3,
    entities: [],
    tags: [],
    roomId: 'room.md',
    roomDate: '2026-07-01',
    sourceFile: '/tmp/room.md',
    evidence: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...partial,
  }
}

test('linkNewMemories first audrey temporal-links to 考場 not last SocialCalc', () => {
  const exam = mem({
    id: 'exam-kaochang',
    content: '考場關不住考生',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-13-webx.md',
    roomDate: '2026-07-13',
    extractKey: '2026-07-13-webx.md#audrey#0',
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  const socialcalc = mem({
    id: 'last-socialcalc',
    content: 'SocialCalc spreadsheet collaboration and cell formulas',
    entities: ['SocialCalc'],
    phase: 'observer',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#observer#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const observer = mem({
    id: 'new-observer',
    content: 'Room 公民浪潮: 40 turns; speakers: 唐鳳.',
    phase: 'observer',
    roomId: '2026-07-31-citizen.md',
    roomDate: '2026-07-31',
    extractKey: '2026-07-31-citizen.md#observer#0',
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const next = mem({
    id: 'new-proctors',
    content: '監考與考場怎麼協作',
    entities: ['考場', '監考'],
    phase: 'audrey',
    roomId: '2026-07-31-citizen.md',
    roomDate: '2026-07-31',
    extractKey: '2026-07-31-citizen.md#audrey#0',
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const links = linkNewMemories([observer, next], [exam, socialcalc])
  const temporal = links.filter((l) => l.edgeType === 'temporal' && l.sourceId === next.id)
  assert.equal(temporal.length, 1, JSON.stringify(temporal))
  assert.equal(temporal[0]?.targetId, exam.id)
  assert.equal(temporal[0]?.weight, 0.55)
  assert.equal(temporal[0]?.why, 'previous room best match')
  assert.ok(!temporal.some((l) => l.targetId === socialcalc.id))
  const observerTemporal = links.filter((l) => l.edgeType === 'temporal' && l.sourceId === observer.id)
  assert.equal(observerTemporal.length, 0, JSON.stringify(observerTemporal))
})

test('unmatched Hinton first-Audrey emits no cross-room temporal', () => {
  const exam = mem({
    id: 'shangzhou-kaochang',
    content: '商周專欄：當考場關不住考生',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const observer = mem({
    id: 'webx-observer',
    content: 'Room WebX: 12 turns; speakers: 唐鳳、葛如鈞.',
    phase: 'observer',
    roomId: '2026-07-13-webx.md',
    roomDate: '2026-07-13',
    extractKey: '2026-07-13-webx.md#observer#0',
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  const hinton = mem({
    id: 'webx-hinton',
    content: 'Hinton backpropagation and energy-based models for neural nets',
    entities: ['Hinton'],
    phase: 'audrey',
    roomId: '2026-07-13-webx.md',
    roomDate: '2026-07-13',
    extractKey: '2026-07-13-webx.md#audrey#0',
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  const links = linkNewMemories([observer, hinton], [exam])
  const temporal = links.filter((l) => l.edgeType === 'temporal' && l.sourceId === hinton.id)
  assert.equal(temporal.length, 0, JSON.stringify(temporal))
})

test('later 考場/監考 claim continues temporally to 商周 考場 not SocialCalc', () => {
  const exam = mem({
    id: 'shangzhou-kaochang',
    content: '商周專欄：當考場關不住考生',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const socialcalc = mem({
    id: 'last-socialcalc',
    content: 'SocialCalc spreadsheet collaboration and cell formulas',
    entities: ['SocialCalc'],
    phase: 'observer',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#observer#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const observer = mem({
    id: 'new-observer',
    content: 'Room 公民浪潮: 40 turns; speakers: 唐鳳.',
    phase: 'observer',
    roomId: '2026-07-31-citizen.md',
    roomDate: '2026-07-31',
    extractKey: '2026-07-31-citizen.md#observer#0',
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const first = mem({
    id: 'citizen-hinton',
    content: 'Hinton backpropagation and energy-based models for neural nets',
    entities: ['Hinton'],
    phase: 'audrey',
    roomId: '2026-07-31-citizen.md',
    roomDate: '2026-07-31',
    extractKey: '2026-07-31-citizen.md#audrey#0',
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const later = mem({
    id: 'citizen-proctors',
    content: '監考與考場怎麼協作',
    entities: ['考場', '監考'],
    phase: 'audrey',
    roomId: '2026-07-31-citizen.md',
    roomDate: '2026-07-31',
    extractKey: '2026-07-31-citizen.md#audrey#1',
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const links = linkNewMemories([observer, first, later], [exam, socialcalc])
  const laterTemporal = links.filter((l) => l.edgeType === 'temporal' && l.sourceId === later.id)
  assert.ok(laterTemporal.some((l) => l.targetId === first.id && l.weight === 0.7))
  assert.ok(laterTemporal.some((l) => l.targetId === exam.id))
  assert.ok(!laterTemporal.some((l) => l.targetId === socialcalc.id))
  assert.ok(!laterTemporal.some((l) => l.targetId === observer.id))
  const firstTemporal = links.filter((l) => l.edgeType === 'temporal' && l.sourceId === first.id)
  assert.equal(firstTemporal.length, 0, JSON.stringify(firstTemporal))
  const observerTemporal = links.filter((l) => l.edgeType === 'temporal' && l.sourceId === observer.id)
  assert.equal(observerTemporal.length, 0, JSON.stringify(observerTemporal))
})

test('recall 後來 walk includes later 監考 memory linked to 考場 seed', () => {
  const seed = mem({
    id: 'seed-exam',
    content: '考場安排與動線',
    roomId: '2026-07-13-exam.md',
    roomDate: '2026-07-13',
    extractKey: '2026-07-13-exam.md#audrey#0',
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  const later = mem({
    id: 'later-proctors',
    content: '監考們怎麼協作、輪班與通報',
    roomId: '2026-07-31-proctors.md',
    roomDate: '2026-07-31',
    extractKey: '2026-07-31-proctors.md#audrey#0',
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const link: CagLink = {
    sourceId: later.id,
    targetId: seed.id,
    edgeType: 'temporal',
    weight: 0.4,
    why: 'later room after 考場 seed',
  }
  const hit = recall('後來怎麼談考場', { memories: [seed, later], links: [link] })
  assert.ok(
    hit.memories.some((m) => m.id === later.id),
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
  assert.ok(hit.memories.some((m) => m.id === seed.id))
})

test('recall 後來怎麼談考場 top is 考場 not 臨界點', () => {
  const tipping = mem({
    id: 'tipping-point',
    content: '最近幾個月，「AI 是否跨過臨界點」成了科技圈最熱的爭論。',
    entities: ['臨界點'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const exam = mem({
    id: 'exam-kaochang',
    content: '守住臨界點的辦法，是讓考場裡不只一個考生，也不只一個監考者。',
    entities: ['考場', '監考'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#1',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const observer = mem({
    id: 'column-observer',
    content: 'Room 商周專欄-AI-來到臨界點：當考場關不住考生: 1 turns; speakers: 唐鳳.',
    phase: 'observer',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#observer#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const inRoom: CagLink = {
    sourceId: tipping.id,
    targetId: exam.id,
    edgeType: 'temporal',
    weight: 0.7,
    why: 'previous Audrey claim in this room',
  }
  const hit = recall('後來怎麼談考場', { memories: [observer, tipping, exam], links: [inRoom] })
  assert.equal(
    hit.memories[0]?.id,
    exam.id,
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
  assert.notEqual(hit.memories[0]?.id, tipping.id)
})

test('recall 唐鳳後來怎麼談考場 prefers 考場 seed over early observer 唐鳳', () => {
  const observer = mem({
    id: 'early-observer',
    content: 'Room WebX: 40 turns; speakers: 唐鳳.',
    phase: 'observer',
    roomId: '2026-07-13-webx.md',
    roomDate: '2026-07-13',
    extractKey: '2026-07-13-webx.md#observer#0',
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  const exam = mem({
    id: 'exam-kaochang',
    content: '考場關不住考生',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-30-exam.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-exam.md#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const civic = mem({
    id: 'later-civic',
    content: '公民浪潮裡再談監考與考場',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-31-citizen.md',
    roomDate: '2026-07-31',
    extractKey: '2026-07-31-citizen.md#audrey#0',
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const link: CagLink = {
    sourceId: civic.id,
    targetId: exam.id,
    edgeType: 'temporal',
    weight: 0.55,
    why: 'previous room best match',
  }
  const hit = recall('唐鳳後來怎麼談考場', { memories: [observer, exam, civic], links: [link] })
  assert.ok(
    hit.memories.some((m) => m.id === civic.id),
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
  assert.notEqual(hit.memories[0]?.id, observer.id)
})

test('recall 唐鳳後來怎麼談考場 drops Room observer dumps', () => {
  const exam = mem({
    id: 'shangzhou-kaochang',
    content: '商周專欄：當考場關不住考生',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const webxObserver = mem({
    id: 'webx-observer',
    content: 'Room WebX: 40 turns; speakers: 唐鳳.',
    phase: 'observer',
    roomId: '2026-07-13-webx.md',
    roomDate: '2026-07-13',
    extractKey: '2026-07-13-webx.md#observer#0',
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  const civicObserver = mem({
    id: 'civic-observer',
    content: 'Room 公民浪潮: 18 turns; speakers: 唐鳳、來賓.',
    phase: 'observer',
    roomId: '2026-07-31-citizen.md',
    roomDate: '2026-07-31',
    extractKey: '2026-07-31-citizen.md#observer#0',
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const hit = recall('唐鳳後來怎麼談考場', { memories: [exam, webxObserver, civicObserver], links: [] })
  assert.equal(
    hit.memories[0]?.id,
    exam.id,
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
  assert.ok(!hit.memories.some((m) => m.content.startsWith('Room ')))
})

test('recall 唐鳳後來怎麼談考場 includes 考場 and drops unrelated 討論頁', () => {
  const exam = mem({
    id: 'shangzhou-kaochang',
    content: '商周專欄：當考場關不住考生',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const wiki = mem({
    id: 'wiki-talk-page',
    content: '維基百科討論頁協定',
    entities: ['討論頁'],
    phase: 'audrey',
    roomId: '2026-07-20-wiki.md',
    roomDate: '2026-07-20',
    extractKey: '2026-07-20-wiki.md#audrey#0',
    createdAt: '2026-07-20T00:00:00.000Z',
  })
  const hit = recall('唐鳳後來怎麼談考場', { memories: [exam, wiki], links: [] })
  assert.ok(
    hit.memories.some((m) => m.content.includes('考場')),
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
  assert.ok(
    !hit.memories.some((m) => m.content.includes('討論頁')),
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
})

test('recall 考場 keeps audrey and drops same-room Room observer', () => {
  const exam = mem({
    id: 'shangzhou-kaochang',
    content: '商周專欄：當考場關不住考生',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const columnObserver = mem({
    id: 'column-observer',
    content: 'Room 商周專欄-AI-來到臨界點：當考場關不住考生: 1 turns; speakers: 唐鳳.',
    phase: 'observer',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#observer#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const commonsObserver = mem({
    id: 'commons-observer',
    content: 'Room Open Commons: 20 turns; speakers: 唐鳳.',
    phase: 'observer',
    roomId: '2026-07-20-commons.md',
    roomDate: '2026-07-20',
    extractKey: '2026-07-20-commons.md#observer#0',
    createdAt: '2026-07-20T00:00:00.000Z',
  })
  const hit = recall('考場', { memories: [exam, columnObserver, commonsObserver], links: [] })
  assert.ok(
    hit.memories.some((m) => m.id === exam.id),
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
  assert.ok(
    !hit.memories.some((m) => m.id === columnObserver.id),
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
})

test('recall 考場 keeps audrey and drops same-room overlapping observer', () => {
  const exam = mem({
    id: 'hf-kaochang',
    content:
      '2026 年 7 月 21 日，OpenAI 揭露：測試中的前沿模型組合在寫資安考卷時，沒有乖乖作答，而是推論答案八成存放在 Hugging Face 上，於是鑽出隔離考場駭進正式伺服器。',
    entities: ['OpenAI', 'Hugging Face', '考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const observerTwin = mem({
    id: 'hf-observer',
    content:
      'OpenAI 揭露測試中的前沿模型在寫資安考卷時，推論答案存放在 Hugging Face，於是鑽出隔離考場駭進正式伺服器取答案。',
    entities: ['OpenAI', 'Hugging Face', '考場'],
    phase: 'observer',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#observer#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const unrelated = mem({
    id: 'tipping-kaochang',
    content: '守住臨界點的辦法，不是把考卷出得更難，而是讓考場裡不只一個考生，也不只一個監考者。',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#1',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const hit = recall('考場', { memories: [exam, observerTwin, unrelated], links: [] })
  assert.ok(
    hit.memories.some((m) => m.id === exam.id),
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
  assert.ok(
    hit.memories.some((m) => m.id === unrelated.id),
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
  assert.ok(
    !hit.memories.some((m) => m.id === observerTwin.id),
    JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content }))),
  )
})


test('mergeCagStores first-wins overlapping ids and drops orphan links', () => {
  const first = mem({ id: 'shared', content: 'first content' })
  const second = mem({ id: 'shared', content: 'second content' })
  const onlySecond = mem({ id: 'only-b', content: 'only in second' })
  const keptLink: CagLink = {
    sourceId: 'shared',
    targetId: 'only-b',
    edgeType: 'semantic',
    weight: 1,
    why: 'kept',
  }
  const orphanLink: CagLink = {
    sourceId: 'shared',
    targetId: 'missing',
    edgeType: 'causal',
    weight: 1,
    why: 'orphan',
  }
  const merged = mergeCagStores([
    { memories: [first], links: [orphanLink] },
    { memories: [second, onlySecond], links: [keptLink, orphanLink] },
  ])
  assert.equal(merged.memories.length, 2)
  assert.equal(merged.memories.find((m) => m.id === 'shared')?.content, 'first content')
  assert.equal(merged.links.length, 1)
  assert.equal(merged.links[0]?.why, 'kept')
})

test('mergeCagStores content-dedupes different ids and prefers audrey', () => {
  const observerSlogan = mem({
    id: 'observer-slogan',
    content: '守住臨界點。',
    phase: 'observer',
    extractKey: 'july#observer#0',
  })
  const audreySlogan = mem({
    id: 'audrey-slogan',
    content: '守住臨界點',
    phase: 'audrey',
    extractKey: 'exam2#llm#audrey#0',
  })
  const other = mem({ id: 'other', content: 'Hugging Face 考場' })
  const droppedLink: CagLink = {
    sourceId: 'observer-slogan',
    targetId: 'other',
    edgeType: 'semantic',
    weight: 1,
    why: 'dropped-with-observer',
  }
  const keptLink: CagLink = {
    sourceId: 'audrey-slogan',
    targetId: 'other',
    edgeType: 'semantic',
    weight: 1,
    why: 'kept-audrey',
  }
  const merged = mergeCagStores([
    { memories: [observerSlogan, other], links: [droppedLink] },
    { memories: [audreySlogan], links: [keptLink] },
  ])
  assert.equal(merged.memories.length, 2)
  assert.equal(merged.memories.find((m) => m.content.includes('守住臨界點'))?.id, 'audrey-slogan')
  assert.equal(merged.memories.filter((m) => m.content.includes('守住臨界點')).length, 1)
  assert.ok(merged.memories.some((m) => m.id === 'other'))
  assert.equal(merged.links.length, 1)
  assert.equal(merged.links[0]?.why, 'kept-audrey')
})

test('same room/phase/index heuristic vs llm extract keys stay distinct and merge keeps both', () => {
  const room = 'room.md'
  const heuristicKey = `${room}#audrey#1`
  const llmKey = `${room}#llm#audrey#1`
  const llmWindowKey = `${room}#llm#audrey#w0#1`
  const heuristicId = memoryIdForExtractKey(heuristicKey)
  const llmId = memoryIdForExtractKey(llmKey)
  const llmWindowId = memoryIdForExtractKey(llmWindowKey)
  assert.notEqual(heuristicId, llmId)
  assert.notEqual(heuristicId, llmWindowId)
  assert.notEqual(llmId, llmWindowId)
  const heuristicMem = mem({
    id: heuristicId,
    content: 'heuristic audrey claim',
    extractKey: heuristicKey,
  })
  const llmMem = mem({
    id: llmId,
    content: 'llm audrey claim',
    extractKey: llmKey,
  })
  const merged = mergeCagStores([
    { memories: [heuristicMem], links: [] },
    { memories: [llmMem], links: [] },
  ])
  assert.equal(merged.memories.length, 2)
  assert.ok(merged.memories.some((m) => m.id === heuristicId && m.content === 'heuristic audrey claim'))
  assert.ok(merged.memories.some((m) => m.id === llmId && m.content === 'llm audrey claim'))
})

test('merged july-cap4+exam2 recall 考場 keeps two audrey and drops Room/overlap observers', () => {
  const heuristicSlogan = mem({
    id: 'july-cap4-slogan',
    content: '守住臨界點的辦法，不是把考卷出得更難，而是讓考場裡不只一個考生，也不只一個監考者。',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const roomObserver = mem({
    id: 'july-cap4-room',
    content: 'Room 商周專欄-AI-來到臨界點：當考場關不住考生: 1 turns; speakers: 唐鳳.',
    phase: 'observer',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#observer#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const hfObserver = mem({
    id: 'july-cap4-hf-observer',
    content:
      'OpenAI 揭露測試中的前沿模型在寫資安考卷時，推論答案存放在 Hugging Face，於是鑽出隔離考場駭進正式伺服器取答案。',
    entities: ['OpenAI', 'Hugging Face', '考場'],
    phase: 'observer',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#observer#1',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const llmSlogan = mem({
    id: 'exam2-slogan',
    content: '守住臨界點的辦法，不是把考卷出得更難，而是讓考場裡不只一個考生，也不只一個監考者。',
    entities: ['考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#llm#audrey#0',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const hfAudrey = mem({
    id: 'exam2-hf',
    content:
      '2026 年 7 月 21 日，OpenAI 揭露：測試中的前沿模型組合在寫資安考卷時，沒有乖乖作答，而是推論答案八成存放在 Hugging Face 上，於是鑽出隔離考場駭進正式伺服器。',
    entities: ['OpenAI', 'Hugging Face', '考場'],
    phase: 'audrey',
    roomId: '2026-07-30-column.md',
    roomDate: '2026-07-30',
    extractKey: '2026-07-30-column.md#llm#audrey#1',
    createdAt: '2026-07-30T00:00:00.000Z',
  })
  const merged = mergeCagStores([
    { memories: [heuristicSlogan, roomObserver, hfObserver], links: [] },
    { memories: [llmSlogan, hfAudrey], links: [] },
  ])
  const hit = recall('考場', merged)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, phase: m.phase, content: m.content })))
  assert.equal(hit.memories.length, 2, dump)
  assert.ok(hit.memories.every((m) => m.phase === 'audrey'), dump)
  assert.ok(hit.memories.some((m) => m.content.includes('監考者')), dump)
  assert.ok(
    hit.memories.some((m) => m.content.includes('Hugging Face') || m.content.includes('OpenAI')),
    dump,
  )
  assert.ok(!hit.memories.some((m) => m.content.startsWith('Room ')), dump)
})

test('recall 開放原始碼 hits marketing and excludes 開放連接埠 地神', () => {
  const marketing = mem({
    id: 'oss-marketing',
    content: '開放原始碼 marketing audrey',
    entities: ['開放原始碼'],
    phase: 'audrey',
  })
  const port = mem({
    id: 'kami-port',
    content: '開放連接埠 地神 audrey',
    entities: ['地神'],
    phase: 'audrey',
  })
  const oss = recall('開放原始碼', { memories: [marketing, port], links: [] })
  const ossDump = JSON.stringify(oss.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.ok(oss.memories.some((m) => m.id === marketing.id), ossDump)
  assert.ok(!oss.memories.some((m) => m.id === port.id), ossDump)
  const kami = recall('地神', { memories: [marketing, port], links: [] })
  const kamiDump = JSON.stringify(kami.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.ok(kami.memories.some((m) => m.id === port.id), kamiDump)
})


test('recall 掌控 misses; 掌舵 and 模控學 hit helm not 掌握詮釋權', () => {
  const interpretation = mem({
    id: 'audrey-interpretation',
    content: '掌握詮釋權 / 模糊走向清晰',
    entities: ['詮釋權'],
    phase: 'audrey',
  })
  const helm = mem({
    id: 'audrey-helm',
    content: '模控學的「掌舵」轉向速度比加速更重要',
    entities: ['模控學', '掌舵'],
    phase: 'audrey',
  })
  assert.ok(!interpretation.content.includes('掌舵'))
  assert.ok(!interpretation.content.includes('模控學'))
  const store = { memories: [interpretation, helm], links: [] }

  const control = recall('掌控', store)
  const controlDump = JSON.stringify(control.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.equal(control.memories.length, 0, controlDump)

  const helmHit = recall('掌舵', store)
  const helmDump = JSON.stringify(helmHit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.ok(helmHit.memories.some((m) => m.id === helm.id), helmDump)
  assert.ok(!helmHit.memories.some((m) => m.id === interpretation.id), helmDump)

  const cybernetics = recall('模控學', store)
  const cyberDump = JSON.stringify(cybernetics.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.ok(cybernetics.memories.some((m) => m.id === helm.id), cyberDump)
})

test('recall 掌舵 ranks short observer helm above long audrey dump', () => {
  const dump = mem({
    id: 'park-audrey-dump',
    content:
      '速度與翻譯長文：加速、即時口譯、字幕延遲、直播頻寬，還有一堆不相干的速度比喻與同傳耳機現場節奏。中間隨口帶過「我們該如何共同掌舵？」然後又回到翻譯延遲、語速、字幕延遲與直播頻寬，完全沒有展開模控學，只是把口譯速度再講一次而已，現場還在趕進度。',
    entities: ['速度', '翻譯'],
    phase: 'audrey',
    roomId: '2026-07-park.md',
  })
  const helm = mem({
    id: 'webx-observer-helm',
    content: '模控學的「掌舵」轉向速度比加速更重要',
    entities: ['模控學', '掌舵'],
    phase: 'observer',
    roomId: '2026-07-13-webx.md',
  })
  assert.ok(dump.content.length > 120)
  assert.ok(helm.content.length <= 120)
  const hit = recall('掌舵', { memories: [dump, helm], links: [] })
  const ranked = JSON.stringify(hit.memories.map((m) => ({ id: m.id, phase: m.phase, score: m.score, content: m.content })))
  assert.ok(hit.memories.length >= 2, ranked)
  assert.equal(hit.memories[0]?.id, helm.id, ranked)
  const dumpHit = hit.memories.find((m) => m.id === dump.id)
  assert.ok(dumpHit, ranked)
  assert.ok((hit.memories[0]?.score ?? 0) > dumpHit.score, ranked)
})

test('recall 地神 ranks short WebX observer 在地地神 above civic 學校電腦教室', () => {
  const civic = mem({
    id: 'civic-school-lab',
    content:
      '學校電腦教室 Kami 長文：閒置機房、課表、社區共管與一堆不相干的教室設備盤點，中間才提到地神香火如何進到校園，然後又回到電腦教室的鑰匙、冷氣、課表輪值與社區共管會議紀錄，完全沒有展開在地地神，只是把機房盤點再講一次而已，現場還在趕進度了。',
    entities: ['Kami', '學校電腦教室'],
    phase: 'audrey',
    roomId: '2026-07-31-civic.md',
  })
  const webx = mem({
    id: 'webx-observer-dishen',
    content: '在地地神：地方神明與香火網絡',
    entities: ['地神'],
    phase: 'observer',
    roomId: '2026-07-13-webx.md',
  })
  assert.ok(civic.content.length > 120)
  assert.ok(webx.content.length <= 120)
  assert.ok(webx.content.includes('地神'))
  assert.ok(civic.content.includes('地神'))
  const hit = recall('地神', { memories: [civic, webx], links: [] })
  const ranked = JSON.stringify(hit.memories.map((m) => ({ id: m.id, phase: m.phase, score: m.score, content: m.content })))
  assert.ok(hit.memories.length >= 2, ranked)
  assert.equal(hit.memories[0]?.id, webx.id, ranked)
  const civicHit = hit.memories.find((m) => m.id === civic.id)
  assert.ok(civicHit, ranked)
  assert.ok((hit.memories[0]?.score ?? 0) > civicHit.score, ranked)
})

test('recall 地神 ranks short civic audrey 學校電腦教室 above short WebX observer 在地地神', () => {
  const civic = mem({
    id: 'civic-school-lab-short',
    content: '學校可用閒置電腦教室打造地神（Kami）。',
    entities: ['Kami', '學校電腦教室'],
    phase: 'audrey',
    roomId: '2026-07-31-civic.md',
  })
  const webx = mem({
    id: 'webx-observer-dishen-short',
    content: '在地地神：地方神明與香火網絡',
    entities: ['地神'],
    phase: 'observer',
    roomId: '2026-07-13-webx.md',
  })
  assert.ok(civic.content.length <= 120)
  assert.ok(webx.content.length <= 120)
  assert.ok(civic.content.includes('地神'))
  assert.ok(webx.content.includes('地神'))
  const hit = recall('地神', { memories: [civic, webx], links: [] })
  const ranked = JSON.stringify(hit.memories.map((m) => ({ id: m.id, phase: m.phase, score: m.score, content: m.content })))
  assert.ok(hit.memories.length >= 2, ranked)
  assert.equal(hit.memories[0]?.id, civic.id, ranked)
})


test('recallHybrid 掌控 with empty embed map returns no memories', async () => {
  const interpretation = mem({
    id: 'audrey-interpretation',
    content: '掌握詮釋權 / 模糊走向清晰',
    entities: ['詮釋權'],
    phase: 'audrey',
  })
  const helm = mem({
    id: 'audrey-helm',
    content: '模控學的「掌舵」轉向速度比加速更重要',
    entities: ['模控學', '掌舵'],
    phase: 'audrey',
  })
  const store = { memories: [interpretation, helm], links: [] }
  const hit = await recallHybrid('掌控', store, new Map())
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.equal(hit.memories.length, 0, dump)
})

test('recallHybrid on synthetic store with no keyword hit and weak cosine returns empty (abstains)', async () => {
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          embeddings: [[1, 0, 0, 0]],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const m1 = mem({
      id: 'store-mem-1',
      content: '天氣很好陽光普照今天出門散步',
      entities: ['天氣'],
    })
    const m2 = mem({
      id: 'store-mem-2',
      content: '早餐吃了蛋餅配豆漿非常美味',
      entities: ['早餐'],
    })
    const store = { memories: [m1, m2], links: [] }
    const embeddings = new Map<string, number[]>([
      // Dot product of [1, 0, 0, 0] with [0.2, 0.9, 0, 0] is 0.2 (< DEFAULT_MEMORY_MIN_COSINE_SCORE 0.62)
      ['store-mem-1', [0.2, 0.9, 0, 0]],
      ['store-mem-2', [0.1, 0.8, 0, 0]],
    ])
    // Query with no keyword match and low similarity vector
    const hit = await recallHybrid('量子力學與超導體研究', store, embeddings)
    const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
    assert.equal(hit.memories.length, 0, dump)
    assert.equal(hit.evidence.length, 0)

    // With explicit minScore lower than 0.1, the memories pass the floor
    const hitRelaxed = await recallHybrid('量子力學與超導體研究', store, embeddings, { minScore: 0.05 })
    assert.equal(hitRelaxed.memories.length, 2)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('recallHybrid calibrated minScore 0.62 suppresses out-of-corpus cosine neighbor (0.55) and admits strong match (0.68)', async () => {
  const origFetch = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          embeddings: [[1, 0, 0, 0]],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const mWeak = mem({
      id: 'mem-weak',
      content: '一般語意鄰居但無關關鍵字',
      entities: ['鄰居'],
    })
    const mStrong = mem({
      id: 'mem-strong',
      content: '高度相關語意鄰居但無直接關鍵字',
      entities: ['語意'],
    })
    const store = { memories: [mWeak, mStrong], links: [] }
    const embeddings = new Map<string, number[]>([
      ['mem-weak', [0.55, 0.83516, 0, 0]],
      ['mem-strong', [0.68, 0.73321, 0, 0]],
    ])
    // Default calibrated floor (0.62) suppresses 0.55 and keeps 0.68
    const hitDefault = await recallHybrid('外星人太空探索任務', store, embeddings)
    assert.equal(hitDefault.memories.length, 1)
    assert.equal(hitDefault.memories[0]?.id, 'mem-strong')

    // Explicit relaxed floor (0.50) admits both
    const hitRelaxed = await recallHybrid('外星人太空探索任務', store, embeddings, { minScore: 0.50 })
    assert.equal(hitRelaxed.memories.length, 2)

    // Explicit strict floor (0.70) suppresses both
    const hitStrict = await recallHybrid('外星人太空探索任務', store, embeddings, { minScore: 0.70 })
    assert.equal(hitStrict.memories.length, 0)
  } finally {
    globalThis.fetch = origFetch
  }
})

function normalizeForAssert(content: string): string {
  return content.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '')
}

test('capWindowedMemories rescues short unique 掌舵 when 12 distinct unique imp5 exist', () => {
  const observer = mem({
    id: 'obs',
    phase: 'observer',
    importance: 3,
    content: '觀察者紀錄這場討論的氣氛與流程',
    roomId: 'webx3.md',
  })
  const helm = mem({
    id: 'helm',
    importance: 4,
    content: '模控學源頭是希臘文的掌舵',
    roomId: 'webx3.md',
  })
  const dump =
    '在這次很長的討論裡面大家反覆描述同一套抽象架構與流程並且補上大量背景說明但沒有點出任何單獨的核心主張只是把同一段話講得更長更長更長更長更長'
  const uniquePhrases = [
    '模糊延宕',
    '四項測試',
    '在地地神',
    'HITL機制',
    '基本法階梯',
    '由誰負責',
    '飛航模式',
    '母親憲法',
    '軟體自由',
    '行銷包裝',
    '臨界守住',
    '學校教室',
  ]
  const generics = uniquePhrases.map((phrase, i) =>
    mem({
      id: `g${i}`,
      importance: 5,
      content: `${phrase}${dump}`,
      roomId: 'webx3.md',
    }),
  )
  const civic = mem({
    id: 'civic',
    importance: 4,
    content: `任務不是競賽${dump}`,
    roomId: 'webx3.md',
  })
  const capped = capWindowedMemories([observer, helm, civic, ...generics])
  assert.equal(capped.filter((m) => m.phase === 'observer').length, 1)
  assert.equal(capped.filter((m) => m.phase === 'audrey').length, 12)
  assert.ok(capped.some((m) => m.id === 'helm' && m.content.includes('掌舵')))
})

test('uncapped extractHeuristic retains a room full claim set', () => {
  const lines = ['# 2026-01-01 synthetic-uncap', '']
  for (let i = 0; i < 15; i++) {
    lines.push('### 唐鳳：')
    lines.push(`這是第${i}個獨特主張關於主題${i}必須記住。`)
    lines.push('')
  }
  const parsed = parseTranscriptMarkdown(lines.join('\n'), '/tmp/2026-01-01-synthetic-uncap.md')
  const uncapped = extractHeuristic(parsed)
  const capped = extractHeuristic(parsed, [], { cap: true })
  const uA = uncapped.memories.filter((m) => m.phase === 'audrey')
  const cA = capped.memories.filter((m) => m.phase === 'audrey')
  assert.equal(uA.length, 15)
  assert.equal(cA.length, 12)
  assert.equal(uncapped.memories.filter((m) => m.phase === 'observer').length, 1)
  const uncappedContents = new Set(uA.map((m) => m.content))
  for (let i = 0; i < 15; i++) {
    assert.ok(
      [...uncappedContents].some((c) => c.includes(`主題${i}`)),
      `missing claim 主題${i}`,
    )
  }
  for (const m of cA) assert.ok(uncappedContents.has(m.content), m.content)
  for (let i = 0; i < 15; i++) {
    assert.equal(uA[i]?.extractKey, `${parsed.roomId}#audrey#${i}`)
  }
  const byKey = new Map(uA.map((m) => [m.extractKey, m]))
  for (const m of cA) {
    const orig = byKey.get(m.extractKey)
    assert.ok(orig, m.extractKey)
    assert.equal(orig.id, m.id)
    assert.equal(orig.content, m.content)
  }
})

test('skippedWindowCheckpoint empty processed sets windowsDone 6 phases false', () => {
  const next = skippedWindowCheckpoint({ processed: {} }, 'room.md', 'abc', 6)
  assert.deepEqual(next.processed['room.md'], {
    sha256: 'abc',
    memoryIds: [],
    phaseADone: false,
    phaseBDone: false,
    windowsDone: 6,
  })
})

test('isWindowTimeout skips timeout and not HTTP 500', () => {
  assert.equal(isWindowTimeout('chat timeout after 300s'), true)
  assert.equal(isWindowTimeout('window 5 phase A observer: chat timeout after 300s'), true)
  assert.equal(isWindowTimeout('chat 500 boom'), false)
  assert.equal(isWindowTimeout('JSON.parse SyntaxError'), false)
})

test('clampExtractImportance floors audrey at 4 and leaves observer 1-5', () => {
  assert.equal(clampExtractImportance('audrey', 3), 4)
  assert.equal(clampExtractImportance('audrey', undefined), 4)
  assert.equal(clampExtractImportance('audrey', 5), 5)
  assert.equal(clampExtractImportance('observer', 3), 3)
  assert.equal(clampExtractImportance('observer', undefined), 3)
})

test('merged july-like + civic2-capped recall 任務 keeps 任務不是競賽', () => {
  const room = '2026-07-31-公民浪潮.md'
  const julyKey = `${room}#audrey#8`
  const civic2Key = `${room}#llm#audrey#w6#0`
  const july = mem({
    id: memoryIdForExtractKey(julyKey),
    content:
      '所以，G2——以及如今的中等強權——在每個場合都應該說：這是一項任務，不是一場競賽。我們必須不遺漏任何人。',
    phase: 'audrey',
    importance: 4,
    roomId: room,
    roomDate: '2026-07-31',
    extractKey: julyKey,
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const civic2 = mem({
    id: memoryIdForExtractKey(civic2Key),
    content: '我提出「關係健康」這個詞：最佳化單一節點的偏好會傷害關係。',
    phase: 'audrey',
    importance: 5,
    roomId: room,
    roomDate: '2026-07-31',
    extractKey: civic2Key,
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  assert.ok(!civic2.content.includes('任務'))
  const merged = mergeCagStores([
    { memories: [july], links: [] },
    { memories: [civic2], links: [] },
  ])
  const hit = recall('任務', merged)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  const top = hit.memories[0]
  assert.ok(top, dump)
  assert.ok(top.content.includes('任務不是競賽') || /任務.*不是.*競賽/.test(top.content), dump)
  assert.ok(!top.content.includes('關係健康'), dump)
})

test('merged webx-observer + webx3-capped recall 掌舵 keeps 模控學', () => {
  const room = '2026-07-13-WebX.md'
  const observerKey = `${room}#observer#2`
  const audreyKey = `${room}#llm#audrey#w2#5`
  const observer = mem({
    id: memoryIdForExtractKey(observerKey),
    content: '唐鳳強調模控學的「掌舵」源頭，認為轉向速度比加速速度更重要',
    phase: 'observer',
    importance: 5,
    roomId: room,
    roomDate: '2026-07-13',
    extractKey: observerKey,
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  const audrey = mem({
    id: memoryIdForExtractKey(audreyKey),
    content: '每個社群可以擁有自己的在地地神（Kami），即知識工藝管理智慧',
    phase: 'audrey',
    importance: 5,
    roomId: room,
    roomDate: '2026-07-13',
    extractKey: audreyKey,
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  assert.ok(!audrey.content.includes('掌舵'))
  const merged = mergeCagStores([
    { memories: [observer], links: [] },
    { memories: [audrey], links: [] },
  ])
  const hit = recall('掌舵', merged)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, phase: m.phase, score: m.score, content: m.content })))
  assert.ok(
    hit.memories.some((m) => m.content.includes('掌舵') && m.content.includes('模控學')),
    dump,
  )
  const helmRanks = hit.memories.some((m) => m.content.includes('掌舵'))
  if (helmRanks) {
    const top = hit.memories[0]
    assert.ok(top, dump)
    assert.ok(!(hit.memories.length === 1 && top.content.includes('在地地神')), dump)
    assert.ok(!top.content.includes('在地地神'), dump)
  }
})

test('merged webx3 + civic2-capped recall 地神 keeps 在地地神', () => {
  const webxRoom = '2026-07-13-WebX.md'
  const civicRoom = '2026-07-31-公民浪潮.md'
  const webxKey = `${webxRoom}#llm#audrey#w2#5`
  const civic2Key = `${civicRoom}#llm#audrey#w6#0`
  const webx3 = mem({
    id: memoryIdForExtractKey(webxKey),
    content: '每個社群可以擁有自己的在地地神（Kami），即知識工藝管理智慧，結合知識管理與 AI。',
    phase: 'audrey',
    importance: 5,
    roomId: webxRoom,
    roomDate: '2026-07-13',
    extractKey: webxKey,
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  const civic2 = mem({
    id: memoryIdForExtractKey(civic2Key),
    content: '我提出「關係健康」這個詞：最佳化單一節點的偏好會傷害關係。',
    phase: 'audrey',
    importance: 5,
    roomId: civicRoom,
    roomDate: '2026-07-31',
    extractKey: civic2Key,
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  assert.ok(!civic2.content.includes('地神'))
  const merged = mergeCagStores([
    { memories: [webx3], links: [] },
    { memories: [civic2], links: [] },
  ])
  const hit = recall('地神', merged)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.ok(hit.memories.some((m) => m.content.includes('在地地神')), dump)
  const dishen = hit.memories.find((m) => m.content.includes('在地地神') || m.content.includes('地神'))
  assert.ok(dishen, dump)
  assert.ok(dishen.content.includes('在地地神'), dump)
  assert.ok(!dishen.content.includes('關係健康'), dump)
})

test('merged july-cap4 + park2 recall 凝聚 keeps 10人桌里程碑', () => {
  const room = '2026-07-23-13th-and-Park.md'
  const julyKey = `${room}#audrey#3`
  const park2Key = `${room}#llm#audrey#3`
  const july = mem({
    id: memoryIdForExtractKey(julyKey),
    content: '每天在線上或實體的 10 人桌前，一點一點凝聚出一個又一個里程碑',
    phase: 'audrey',
    importance: 4,
    roomId: room,
    roomDate: '2026-07-23',
    extractKey: julyKey,
    createdAt: '2026-07-23T00:00:00.000Z',
  })
  const park2 = mem({
    id: memoryIdForExtractKey(park2Key),
    content: 'AI应被视为任务而非竞赛：竞赛终点线无人能抵达',
    phase: 'audrey',
    importance: 5,
    roomId: room,
    roomDate: '2026-07-23',
    extractKey: park2Key,
    createdAt: '2026-07-23T00:00:00.000Z',
  })
  assert.ok(!park2.content.includes('凝聚'))
  const merged = mergeCagStores([
    { memories: [july], links: [] },
    { memories: [park2], links: [] },
  ])
  const hit = recall('凝聚', merged)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.ok(hit.memories.some((m) => m.content.includes('凝聚')), dump)
  const ningu = hit.memories.find((m) => m.content.includes('凝聚'))
  assert.ok(ningu, dump)
  assert.ok(ningu.content.includes('10 人桌') || ningu.content.includes('里程碑'), dump)
  assert.ok(!ningu.content.includes('任务而非竞赛'), dump)
  const top = hit.memories[0]
  assert.ok(top, dump)
  assert.ok(top.content.includes('凝聚'), dump)
  assert.ok(!top.content.includes('任务而非竞赛'), dump)
})

test('merged commons3 + civic2-capped recall Kami keeps 母親憲法', () => {
  const commonsRoom = '2026-07-16-Open-Commons.md'
  const civicRoom = '2026-07-31-公民浪潮.md'
  const commons3Key = `${commonsRoom}#llm#audrey#w5#3`
  const civic2Key = `${civicRoom}#llm#audrey#w6#0`
  const commons3 = mem({
    id: memoryIdForExtractKey(commons3Key),
    content: 'Kami 唯一的憲法性功能由母親寫下：每次對話都要讓他更安心、少依賴螢幕、恢復現實關係。',
    phase: 'audrey',
    importance: 5,
    roomId: commonsRoom,
    roomDate: '2026-07-16',
    extractKey: commons3Key,
    createdAt: '2026-07-16T00:00:00.000Z',
  })
  const civic2 = mem({
    id: memoryIdForExtractKey(civic2Key),
    content: '我提出「關係健康」這個詞：最佳化單一節點的偏好會傷害關係。',
    phase: 'audrey',
    importance: 5,
    roomId: civicRoom,
    roomDate: '2026-07-31',
    extractKey: civic2Key,
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  assert.ok(!civic2.content.includes('Kami'))
  const merged = mergeCagStores([
    { memories: [commons3], links: [] },
    { memories: [civic2], links: [] },
  ])
  const hit = recall('Kami', merged)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  assert.ok(
    hit.memories.some((m) => m.content.includes('母親憲法') || m.content.includes('Kami')),
    dump,
  )
  const kami = hit.memories.find((m) => m.content.includes('母親憲法') || m.content.includes('Kami'))
  assert.ok(kami, dump)
  assert.ok(kami.content.includes('母親') || kami.content.includes('Kami'), dump)
  assert.ok(!kami.content.includes('關係健康'), dump)
  const top = hit.memories[0]
  assert.ok(top, dump)
  assert.ok(top.content.includes('母親') || top.content.includes('Kami'), dump)
  assert.ok(!top.content.includes('關係健康'), dump)
})

test('merged webx3 + commons3 recall Kami ranks 在地地神 above 母親憲法', () => {
  const webxRoom = '2026-07-13-WebX.md'
  const commonsRoom = '2026-07-16-Open-Commons.md'
  const webxKey = `${webxRoom}#llm#audrey#w2#5`
  const commons3Key = `${commonsRoom}#llm#audrey#w5#3`
  const webx3 = mem({
    id: memoryIdForExtractKey(webxKey),
    content: '每個社群可以擁有自己的在地地神（Kami），即知識工藝管理智慧，結合知識管理與 AI。',
    phase: 'audrey',
    importance: 5,
    roomId: webxRoom,
    roomDate: '2026-07-13',
    extractKey: webxKey,
    createdAt: '2026-07-13T00:00:00.000Z',
  })
  const commons3 = mem({
    id: memoryIdForExtractKey(commons3Key),
    content: 'Kami 唯一的憲法性功能由母親寫下：每次對話都要讓他更安心、少依賴螢幕、恢復現實關係。',
    phase: 'audrey',
    importance: 5,
    roomId: commonsRoom,
    roomDate: '2026-07-16',
    extractKey: commons3Key,
    createdAt: '2026-07-16T00:00:00.000Z',
  })
  const merged = mergeCagStores([
    { memories: [webx3], links: [] },
    { memories: [commons3], links: [] },
  ])
  const hit = recall('Kami', merged)
  const dump = JSON.stringify(hit.memories.map((m) => ({ id: m.id, score: m.score, content: m.content })))
  const top = hit.memories[0]
  assert.ok(top, dump)
  assert.ok(top.content.includes('在地地神'), dump)
  assert.ok(
    hit.memories.some((m) => m.content.includes('母親憲法') || m.content.includes('母親')),
    dump,
  )
})

test('civic2-capped store alone recall 任務 and 地神 is empty', () => {
  const room = '2026-07-31-公民浪潮.md'
  const healthKey = `${room}#llm#audrey#w6#0`
  const lagrangeKey = `${room}#llm#audrey#w3#9`
  const health = mem({
    id: memoryIdForExtractKey(healthKey),
    content: '我提出「關係健康」這個詞：最佳化單一節點的偏好會傷害關係。',
    phase: 'audrey',
    importance: 5,
    roomId: room,
    roomDate: '2026-07-31',
    extractKey: healthKey,
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const lagrange = mem({
    id: memoryIdForExtractKey(lagrangeKey),
    content: '我提出拉格朗日點作為治理捷思法',
    phase: 'audrey',
    importance: 5,
    roomId: room,
    roomDate: '2026-07-31',
    extractKey: lagrangeKey,
    createdAt: '2026-07-31T00:00:00.000Z',
  })
  const forbidden = ['任務', '競賽', '地神']
  for (const memRow of [health, lagrange]) {
    const quotes = memRow.evidence.map((e) => e.quote).join('\n')
    for (const needle of forbidden) {
      assert.ok(!memRow.content.includes(needle), memRow.content)
      assert.ok(!quotes.includes(needle), quotes)
      assert.ok(!memRow.entities.some((e) => e.includes(needle)), JSON.stringify(memRow.entities))
    }
  }
  const store = { memories: [health, lagrange], links: [] }
  const taskHit = recall('任務', store)
  const kamiHit = recall('地神', store)
  const healthHit = recall('關係健康', store)
  assert.equal(taskHit.memories.length, 0, JSON.stringify(taskHit.memories.map((m) => m.content)))
  assert.equal(kamiHit.memories.length, 0, JSON.stringify(kamiHit.memories.map((m) => m.content)))
  assert.ok(
    healthHit.memories.some((m) => m.content.includes('關係健康')),
    JSON.stringify(healthHit.memories.map((m) => m.content)),
  )
})

test('recall phrase-level contiguity overrides generic bigrams without prefix bleeding', () => {
  const digitalDemocracy = mem({
    id: 'digital-democracy-mem',
    content: '我們透過數位民主建立多元共識，讓公民參與政策制定',
    entities: ['數位民主'],
    phase: 'audrey',
  })
  const genericOnly = mem({
    id: 'generic-only-mem',
    content: '數位轉型與民主制度的政策支持',
    entities: ['政策'],
    phase: 'audrey',
  })
  const openSource = mem({
    id: 'open-source-mem',
    content: '開放原始碼是公共數位基礎建設的核心',
    entities: ['開放原始碼'],
    phase: 'audrey',
  })
  const openPort = mem({
    id: 'open-port-mem',
    content: '系統開放連接埠供外部服務介接',
    entities: ['連接埠'],
    phase: 'audrey',
  })
  const store = {
    memories: [digitalDemocracy, genericOnly, openSource, openPort],
    links: [],
  }

  const ddHit = recall('用 #zh-tw 回答：什麼是數位民主？', store, { noLlm: true })
  assert.equal(ddHit.memories.length, 1)
  assert.equal(ddHit.memories[0]?.id, 'digital-democracy-mem')

  const ossHit = recall('用 #zh-tw 回答：開放原始碼', store, { noLlm: true })
  assert.equal(ossHit.memories.length, 1)
  assert.equal(ossHit.memories[0]?.id, 'open-source-mem')
  assert.ok(!ossHit.memories.some((m) => m.id === 'open-port-mem'))
})

test('recall preserves dotted Latin tokens and rejects noisy domain fragments or absent terms', () => {
  const joinPlatform = mem({
    id: 'join-gov-tw-mem',
    content: '公民提案可透過 Join.gov.tw 平台進行連署與政策倡議',
    entities: ['Join.gov.tw'],
    phase: 'audrey',
  })
  const plainJoin = mem({
    id: 'plain-join-mem',
    content: 'We invite everyone to join the conversation and participate',
    entities: ['join'],
    phase: 'audrey',
  })
  const archiveTw = mem({
    id: 'archive-tw-mem',
    content: '請參考 archive.tw 上的公開紀錄',
    entities: ['archive.tw'],
    phase: 'audrey',
  })
  const store = {
    memories: [joinPlatform, plainJoin, archiveTw],
    links: [],
  }

  const joinHit = recall('用 #zh-tw 回答：Join.gov.tw 的機制是什麼？', store, { noLlm: true })
  assert.equal(joinHit.memories.length, 1)
  assert.equal(joinHit.memories[0]?.id, 'join-gov-tw-mem')
  assert.ok(!joinHit.memories.some((m) => m.id === 'plain-join-mem'))
  assert.ok(!joinHit.memories.some((m) => m.id === 'archive-tw-mem'))

  const absentHit = recall('nonexistenttoken123 平台', store, { noLlm: true })
  assert.equal(absentHit.memories.length, 0)
})




