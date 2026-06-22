import assert from 'node:assert/strict'
import test from 'node:test'

import { splitSqlIntoImportFiles } from '../scripts/build-bigram-index-split'

test('splitSqlIntoImportFiles: keeps everything in one file when under the byte limit', () => {
  const files = splitSqlIntoImportFiles('H;\n', ['A;\n', 'B;\n', 'C;\n'], 100)
  assert.deepEqual(files, ['H;\nA;\nB;\nC;\n'])
})

test('splitSqlIntoImportFiles: splits into multiple files, header stays in the first file', () => {
  const files = splitSqlIntoImportFiles('H;\n', ['A;\n', 'B;\n', 'C;\n'], 5)
  assert.deepEqual(files, ['H;\n', 'A;\n', 'B;\n', 'C;\n'])
  for (const f of files) {
    assert.ok(Buffer.byteLength(f, 'utf-8') <= 5, `oversized part: ${f}`)
  }
})

test('splitSqlIntoImportFiles: measures UTF-8 bytes, not characters (CJK)', () => {
  // 「萌典;\n」= 6 (兩個 3-byte 漢字) + 2 = 8 bytes，但只有 4 個字元。
  // maxBytes=10 下，header(3) + 8 = 11 > 10 必須切檔；若誤用字元長度則不會切。
  const stmt = '萌典;\n'
  assert.equal(Buffer.byteLength(stmt, 'utf-8'), 8)
  const files = splitSqlIntoImportFiles('H;\n', [stmt, stmt], 10)
  assert.deepEqual(files, ['H;\n', stmt, stmt])
})

test('splitSqlIntoImportFiles: an oversized single statement gets its own file (no infinite loop, no empty file)', () => {
  const big = 'XXXXX;\n' // 7 bytes > maxBytes
  const files = splitSqlIntoImportFiles('H;\n', [big], 4)
  assert.deepEqual(files, ['H;\n', big])
  for (const f of files) assert.ok(f.length > 0, 'no empty file body')
})

test('splitSqlIntoImportFiles: empty statement list still emits the header file', () => {
  assert.deepEqual(splitSqlIntoImportFiles('H;\n', [], 5), ['H;\n'])
})
