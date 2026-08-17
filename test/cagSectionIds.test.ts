import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  filenameFromRoomId,
  htmlToPlainText,
  memoriesToCagSources,
  parseArchiveSpeechPayload,
  resolveSectionId,
  resolveSectionMatch,
  type ArchiveSection,
  type CagMemory,
} from '../src/utils/cagMemories'

const SECTIONS_FIXTURE = path.resolve(
  'test/fixtures/cag-memories/2026-06-10-創意官吏獎得獎感言.sections.json',
)

function loadFixtureSections(): ArchiveSection[] {
  return parseArchiveSpeechPayload(JSON.parse(readFileSync(SECTIONS_FIXTURE, 'utf8')))
}

function mem(partial: Pick<CagMemory, 'id' | 'content'> & Partial<CagMemory>): CagMemory {
  return {
    extractKey: `${partial.id}#audrey#0`,
    phase: 'audrey',
    category: 'fact',
    importance: 3,
    entities: [],
    tags: [],
    roomId: '2026-06-10-創意官吏獎得獎感言.md',
    roomDate: '2026-06-10',
    sourceFile: '/tmp/2026-06-10-創意官吏獎得獎感言.md',
    evidence: [],
    createdAt: '2026-06-10T00:00:00.000Z',
    ...partial,
  }
}

test('checked-in section fixture is a top-level array with section_id and name', () => {
  const sections = loadFixtureSections()
  assert.ok(sections.length >= 2)
  assert.equal(typeof sections[0]?.section_id, 'number')
  assert.ok(sections[0]?.section_content)
  assert.equal(sections[0]?.name, '唐鳳')
})

test('htmlToPlainText strips p/br the way vectorize-sync does', () => {
  assert.equal(
    htmlToPlainText('<p>耕耘資料土壤，<br>\n不要開採資料石油。</p>\n'),
    '耕耘資料土壤， 不要開採資料石油。',
  )
})

test('resolveSectionId matches a claim quote after br and whitespace collapse', () => {
  const sections = loadFixtureSections()
  const id = resolveSectionId('耕耘資料土壤，<br>\n不要開採資料石油。', sections)
  assert.equal(id, 63856814)
})

test('resolveSectionId matches HTML-ish section content against a plain quote', () => {
  const sections = loadFixtureSections()
  const id = resolveSectionId('泥板，是有記性的土壤。資料也是：攜手耕作，才會鮮活；每次收成，就更肥沃。', sections)
  assert.equal(id, 63856813)
})

test('resolveSectionId returns null when the quote is not in the speech', () => {
  const sections = loadFixtureSections()
  assert.equal(resolveSectionId('this quote is not in the fixture speech at all', sections), null)
})

test('long quote that spans sections resolves via contained section', () => {
  const sections = loadFixtureSections()
  const quote = [
    '五千年前，尖筆壓進泥板。<br>',
    '最古老的書寫，是記帳：<br>',
    '村裡共有的資糧，<br>',
    '數清、存好，<br>',
    '讓全村活過冬天。',
    '第一位書寫者，是官吏。<br>',
    '帝國成塵，帳冊長存。',
  ].join('\n')
  const hit = resolveSectionMatch(quote, sections)
  assert.ok(hit)
  assert.equal(hit.via, 'section-in-quote')
  assert.ok(hit.sectionId === 63856811 || hit.sectionId === 63856812)
})

test('filenameFromRoomId strips .md', () => {
  assert.equal(filenameFromRoomId('2026-06-10-創意官吏獎得獎感言.md'), '2026-06-10-創意官吏獎得獎感言')
})

test('memoriesToCagSources cites audrey only when sectionId is resolved', () => {
  const citedMem = mem({
    id: 'cited',
    content: '耕耘資料土壤，不要開採資料石油。',
    evidence: [{
      file: '/tmp/room.md',
      turnIndex: 0,
      speaker: '唐鳳',
      startChar: 0,
      endChar: 10,
      quote: '耕耘資料土壤，不要開採資料石油。',
      sectionId: 63856814,
    }],
  })
  const unresolved = mem({
    id: 'open',
    content: '主權如果只靠一位好官',
    evidence: [{
      file: '/tmp/room.md',
      turnIndex: 0,
      speaker: '唐鳳',
      startChar: 0,
      endChar: 10,
      quote: '主權如果只靠一位好官',
      sectionId: null,
    }],
  })
  const observer = mem({
    id: 'obs',
    phase: 'observer',
    content: 'Room notes',
    evidence: [{
      file: '/tmp/room.md',
      turnIndex: 0,
      speaker: '唐鳳',
      startChar: 0,
      endChar: 10,
      quote: '五千年前',
      sectionId: 63856811,
    }],
  })
  const { cited, background } = memoriesToCagSources(
    [citedMem, unresolved, observer],
    { [citedMem.roomId]: '2026-06-10 「創意官吏獎」得獎感言' },
  )
  assert.equal(cited.length, 1)
  assert.equal(cited[0]?.sectionId, 63856814)
  assert.equal(cited[0]?.href, 'https://archive.tw/2026-06-10-創意官吏獎得獎感言#s63856814')
  assert.equal(background.length, 2)
  assert.ok(background.some((s) => s.href.startsWith('file://') && s.sectionId === null))
  assert.ok(background.some((s) => s.content.includes('Room notes')))
})

test('memoriesToCagSources keeps LLM-path memories in background even with a resolved sectionId', () => {
  const llm = mem({
    id: 'llm-para',
    extractKey: '2026-06-10-創意官吏獎得獎感言.md#llm#audrey#3',
    content: 'Audrey argues we should tend data as soil rather than extract it as oil.',
    evidence: [{
      file: '/tmp/room.md',
      turnIndex: 0,
      speaker: '唐鳳',
      startChar: 0,
      endChar: 10,
      quote: '耕耘資料土壤，不要開採資料石油。',
      sectionId: 63856814,
    }],
  })
  const { cited, background } = memoriesToCagSources(
    [llm],
    { [llm.roomId]: '2026-06-10 「創意官吏獎」得獎感言' },
  )
  assert.equal(cited.length, 0)
  assert.equal(background.length, 1)
  assert.equal(background[0]?.sectionId, null)
  assert.ok(background[0]?.href.startsWith('file://'))
  assert.match(background[0]?.content ?? '', /tend data as soil/)
})

function runResolver(args: string[], cwd = path.resolve('.')) {
  const npx = path.join(path.dirname(process.execPath), 'npx')
  return spawnSync(
    npx,
    ['tsx', '--tsconfig', 'scripts/tsconfig.json', 'scripts/resolve-section-ids.ts', ...args],
    { encoding: 'utf8', cwd, shell: false },
  )
}

test('resolver CLI refuses to clobber a non-empty store without --resume or --force', () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'cag-sec-'))
  try {
    writeFileSync(path.join(outDir, 'memories.jsonl'), `${JSON.stringify({
      kind: 'memory',
      id: 'm1',
      extractKey: 'room.md#audrey#0',
      phase: 'audrey',
      category: 'fact',
      importance: 3,
      content: '耕耘資料土壤，不要開採資料石油。',
      entities: [],
      tags: [],
      roomId: '2026-06-10-創意官吏獎得獎感言.md',
      roomDate: '2026-06-10',
      sourceFile: '/tmp/room.md',
      evidence: [{
        file: '/tmp/room.md',
        turnIndex: 0,
        speaker: '唐鳳',
        startChar: 0,
        endChar: 8,
        quote: '耕耘資料土壤，不要開採資料石油。',
        sectionId: null,
      }],
      createdAt: '2026-06-10T00:00:00.000Z',
    })}\n`)
    const before = readFileSync(path.join(outDir, 'memories.jsonl'), 'utf8')
    const run = runResolver(['--store', outDir, '--sections-json', SECTIONS_FIXTURE])
    assert.equal(run.status, 2, `${String(run.error ?? '')}\n${run.stderr || run.stdout}`)
    assert.match(run.stderr, /refusing to wipe non-empty store/)
    assert.equal(readFileSync(path.join(outDir, 'memories.jsonl'), 'utf8'), before)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('resolver CLI --resume writes sectionId from the checked-in fixture and is idempotent', () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'cag-sec-'))
  try {
    writeFileSync(path.join(outDir, 'memories.jsonl'), `${JSON.stringify({
      kind: 'memory',
      id: 'm1',
      extractKey: 'room.md#audrey#0',
      phase: 'audrey',
      category: 'fact',
      importance: 3,
      content: '耕耘資料土壤，不要開採資料石油。',
      entities: [],
      tags: [],
      roomId: '2026-06-10-創意官吏獎得獎感言.md',
      roomDate: '2026-06-10',
      sourceFile: '/tmp/room.md',
      evidence: [{
        file: '/tmp/room.md',
        turnIndex: 0,
        speaker: '唐鳳',
        startChar: 0,
        endChar: 8,
        quote: '耕耘資料土壤，<br>不要開採資料石油。',
        sectionId: null,
      }],
      createdAt: '2026-06-10T00:00:00.000Z',
    })}\n${JSON.stringify({
      kind: 'link',
      sourceId: 'm1',
      targetId: 'm1',
      edgeType: 'temporal',
      weight: 0.5,
      why: 'self',
    })}\n`)
    const first = runResolver(['--store', outDir, '--resume', '--sections-json', SECTIONS_FIXTURE])
    assert.equal(first.status, 0, `${String(first.error ?? '')}\n${first.stderr || first.stdout}`)
    const rec = JSON.parse(readFileSync(path.join(outDir, 'memories.jsonl'), 'utf8').trim().split('\n')[0] ?? '{}')
    assert.equal(rec.evidence[0].sectionId, 63856814)
    const second = runResolver(['--store', outDir, '--resume', '--sections-json', SECTIONS_FIXTURE])
    assert.equal(second.status, 0, `${String(second.error ?? '')}\n${second.stderr || second.stdout}`)
    assert.match(second.stderr, /skipped=1/)
    const rec2 = JSON.parse(readFileSync(path.join(outDir, 'memories.jsonl'), 'utf8').trim().split('\n')[0] ?? '{}')
    assert.equal(rec2.evidence[0].sectionId, 63856814)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
