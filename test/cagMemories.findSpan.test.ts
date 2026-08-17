import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { findSpan, parseTranscriptMarkdown } from '../src/utils/cagMemories'

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

function collapseBrAndWs(s: string): string {
  return s.replace(/<br\s*\/?>/gi, '').replace(/\s+/g, '')
}

test('findSpan 耕耘資料土壤 quote is byte-identical after collapsing <br> and whitespace', () => {
  const file = transcriptPath()
  const parsed = parseTranscriptMarkdown(readFileSync(file, 'utf8'), file)
  const turn = parsed.turns[0]
  assert.ok(turn)
  assert.ok(turn.text.includes('耕耘資料土壤'))
  const needle = '耕耘資料土壤，不要開採資料石油。'
  const span = findSpan(turn.text, needle)
  assert.equal(turn.text.slice(span.startChar, span.startChar + 6), '耕耘資料土壤')
  assert.equal(collapseBrAndWs(span.quote).startsWith(collapseBrAndWs(needle)), true)
  assert.ok(span.quote.includes('<br'))
})
