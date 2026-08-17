import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  auditArmDistinctness,
  auditCircularity,
  auditDegeneracy,
  auditSample,
  auditVerdictSupport,
  checkAgainstRefuted,
  verdictOf,
  type ArmRetrieval,
  type AuditReport,
  type Finding,
  type UnitScore,
} from '../src/utils/autoresearch'
import {
  auditBlindingFiles,
  auditProvenancePaths,
  auditStaleness,
  loadLexicalInstruments,
} from '../src/utils/autoresearchFs'
import { auditLexicalInstrument } from '../src/utils/autoresearchInstrument'
import {
  DEFAULT_AUDREY_EVAL_CASES,
  DEFAULT_CAG_EVAL_CASES,
} from '../src/utils/cagEval'

const HELDOUT_PATH = path.resolve('local/cag-compare/heldout-questions.json')
const CONTEXTS_PATH = path.resolve('local/cag-compare/eval-contexts.json')
const CONTEXTS_KEY_PATH = path.resolve('local/cag-compare/eval-contexts.json.key.json')

const REAL_LOG_CANDIDATES = [
  '/tmp/cag-full-compare.log',
  '/tmp/cag-union-compare.log',
  '/tmp/cag-heldout-verify.log',
  '/tmp/cag-abstention.log',
]

const ZERO_UNIT_IDS = [
  'au-digital-democracy-reframe-zh',
  'au-join-zh',
  'au-open-government-zh',
] as const

const GENUINE_TOPIC_TERMS = [
  '開放原始碼',
  'vTaiwan',
  '口罩地圖',
  '數位簽章',
  '仁工智慧',
  '審議',
  '地神',
  '多元宇宙',
] as const

const BLINDING_VOCABULARY = [
  '"arm"',
  'sections-only',
  'memory-keyword',
  'union-rrf',
] as const

const CIRCULAR_ARMS = {
  memory: ['lexical-term', 'idf', 'lexical-phrase'],
  sections: ['embedding-cosine'],
  union: ['rank-fusion'],
} as const

const UNIT_IDS = [
  ...DEFAULT_CAG_EVAL_CASES.map((c) => c.id),
  ...DEFAULT_AUDREY_EVAL_CASES.map((c) => c.id),
]

function isBlocker(finding: Finding): boolean {
  return finding.severity === 'blocker'
}

function isWarning(finding: Finding): boolean {
  return finding.severity === 'warning'
}

function isNote(finding: Finding): boolean {
  return finding.severity === 'note'
}

function gateId(finding: Finding): string {
  if (typeof finding.gate === 'string' && finding.gate.length > 0) return finding.gate
  if (typeof finding.code === 'string') return finding.code
  return ''
}

function hasGate(finding: Finding, gate: string): boolean {
  return gateId(finding) === gate
}

function findingText(finding: Finding): string {
  // Must NOT be JSON.stringify: that escapes inner quotes, so a message
  // containing "arm" becomes \"arm\" and substring checks silently never match.
  return [finding.message, finding.path ?? '', (finding.unitIds ?? []).join(' ')].join(' ')
}

function blockersFor(findings: readonly Finding[], gate: string): Finding[] {
  return findings.filter((f) => isBlocker(f) && hasGate(f, gate))
}

function warningsFor(findings: readonly Finding[], gate: string): Finding[] {
  return findings.filter((f) => isWarning(f) && hasGate(f, gate))
}

function skipIfMissing(t: { skip: (reason?: string) => void }, filePath: string): boolean {
  if (existsSync(filePath)) return false
  t.skip(`${filePath} is absent — skip so a clean checkout stays green`)
  return true
}

function memoryScores(zeroIds: readonly string[]): UnitScore[] {
  assert.equal(UNIT_IDS.length, 21)
  return UNIT_IDS.map((unitId, i) => ({
    unitId,
    armId: 'memory',
    value: zeroIds.includes(unitId) ? 0 : 0.9 + (i % 5) * 0.008,
  }))
}

function keywordItems(unitId: string): string[] {
  return [`kw:${unitId}:1`, `kw:${unitId}:2`, `kw:${unitId}:3`, `kw:${unitId}:4`]
}

function sectionItems(unitId: string): string[] {
  return [`sec:${unitId}:1`, `sec:${unitId}:2`, `sec:${unitId}:3`, `sec:${unitId}:4`]
}

function hybridDiverged(unitId: string): string[] {
  return [`hy:${unitId}:1`, `hy:${unitId}:2`, `hy:${unitId}:3`, `hy:${unitId}:4`]
}

function retrievalsFor(
  rows: Array<{ armId: string; units: readonly string[]; items: (unitId: string) => string[] }>,
): ArmRetrieval[] {
  const out: ArmRetrieval[] = []
  for (const row of rows) {
    for (const unitId of row.units) {
      out.push({ armId: row.armId, unitId, itemIds: row.items(unitId) })
    }
  }
  return out
}

test('circularity: lexical-term precision is the memory arm’s own objective and cannot decide a sections comparison', () => {
  const circular = auditCircularity({
    metric: ['lexical-term'],
    arms: CIRCULAR_ARMS,
  })
  const blockers = blockersFor(circular, 'circularity')
  assert.ok(
    blockers.length >= 1,
    'lexical-term vs memory:{lexical-term,idf,lexical-phrase} must BLOCK on gate circularity',
  )
  for (const finding of blockers) {
    const text = findingText(finding)
    assert.match(text, /memory/)
    assert.match(text, /sections/)
    // `union` is a rank-fusion arm: it inherits every other arm's families, so it
    // can never be the orthogonal arm B. The blocker must not name it.
    assert.equal(
      /union/.test(text),
      false,
      'a rank-fusion arm can never be the orthogonal arm in a circularity blocker',
    )
    assert.equal(
      /orthogonal to arm union/.test(text),
      false,
      'union (rank-fusion) must never be reported as the orthogonal arm',
    )
  }

  const blind = auditCircularity({
    metric: ['llm-judgement'],
    arms: CIRCULAR_ARMS,
  })
  assert.equal(
    blockersFor(blind, 'circularity').length,
    0,
    'llm-judgement is orthogonal to every retrieval arm — that is why blind answer-level judging was a valid instrument',
  )
})

test('degeneracy: three memory-arm units sat at 0.000 (au-digital-democracy-reframe-zh, au-join-zh, au-open-government-zh) and a single zero must not warn', () => {
  const preFix = auditDegeneracy({ arm: 'memory', scores: memoryScores(ZERO_UNIT_IDS) })
  const warnings = warningsFor(preFix, 'degeneracy')
  assert.ok(warnings.length >= 1, '3/21 exact zeros at the pre-fix shape must warn')
  const named = warnings.map((f) => `${findingText(f)} ${(f.unitIds ?? []).join(' ')}`).join('\n')
  for (const id of ZERO_UNIT_IDS) {
    assert.match(named, new RegExp(id))
  }

  const singleZero = auditDegeneracy({
    arm: 'memory',
    scores: memoryScores(['au-join-zh']),
  })
  assert.equal(
    warningsFor(singleZero, 'degeneracy').length,
    0,
    'one zero out of 21 is not the degeneracy that hid the scorer bugs',
  )
})

test('instrument: held-out ground truth was fixed-width Han slices, not topic terms', (t) => {
  if (skipIfMissing(t, HELDOUT_PATH)) return

  const instruments = loadLexicalInstruments(HELDOUT_PATH)
  const findings = auditLexicalInstrument(instruments)
  assert.ok(
    blockersFor(findings, 'function-char-share').length >= 1,
    'heldout-questions.json must BLOCK on gate function-char-share (虛字 windows such as 而且我們的)',
  )
  assert.ok(
    blockersFor(findings, 'fixed-width-sliced').length >= 1,
    'heldout-questions.json must BLOCK on gate fixed-width-sliced (length spike at 4–5, e.g. 常重要的價)',
  )

  const control = auditLexicalInstrument(
    GENUINE_TOPIC_TERMS.map((term) => ({
      unitId: `control:${term}`,
      terms: [term],
    })),
  )
  assert.equal(
    blockersFor(control, 'function-char-share').length,
    0,
    'genuine topic terms must not trip function-char-share',
  )
  assert.equal(
    blockersFor(control, 'fixed-width-sliced').length,
    0,
    'genuine topic terms must not trip fixed-width-sliced',
  )
})

test('sample: join-key equality was claimed from 1 of 105 rooms', () => {
  const overclaim = auditSample({ kind: 'equality', population: 105, observed: 1 })
  assert.ok(
    blockersFor(overclaim, 'sample').length >= 1,
    'equality at observed=1 / population=105 is the join-key overclaim and must BLOCK',
  )

  const measured = auditSample({ population: 105, observed: 49 })
  assert.equal(
    blockersFor(measured, 'sample').length,
    0,
    '49/105 is the measured as-is basename hit rate, not an n=1 equality claim',
  )
})

test('blinding: eval-contexts.json.key.json leaks "arm" while the blinded contexts file does not', (t) => {
  if (skipIfMissing(t, CONTEXTS_PATH)) return
  if (skipIfMissing(t, CONTEXTS_KEY_PATH)) return

  const vocab = [...BLINDING_VOCABULARY]
  const blinded = auditBlindingFiles({
    labelVocabulary: vocab,
    judgeVisiblePaths: [CONTEXTS_PATH],
  })
  assert.equal(
    blockersFor(blinded, 'blinding').length,
    0,
    'eval-contexts.json is the judge-visible dump and must stay free of arm labels',
  )

  const leaked = auditBlindingFiles({
    labelVocabulary: vocab,
    judgeVisiblePaths: [CONTEXTS_KEY_PATH],
  })
  const armLeak = leaked.filter(
    (f) => isBlocker(f) && hasGate(f, 'blinding') && findingText(f).includes('"arm"'),
  )
  assert.ok(
    armLeak.length >= 1,
    'the sidecar key file is where "arm" lives; a blinding gate that cannot see it has regressed',
  )
})

test('verdict-support: a collapse verdict with empty scores and empty logPaths is not a result', () => {
  const unsupported = auditVerdictSupport({
    verdict: 'collapse',
    scores: [],
    logPaths: [],
  })
  assert.ok(
    blockersFor(unsupported, 'verdict-support').length >= 1,
    'collapse with no scores and no logs must BLOCK — that was the held-out worker’s empty verdict',
  )

  const existingLog =
    REAL_LOG_CANDIDATES.find((p) => existsSync(p)) ??
    path.join(mkdtempSync(path.join(os.tmpdir(), 'autoresearch-verdict-')), 'compare.log')
  if (!existsSync(existingLog)) {
    writeFileSync(
      existingLog,
      'memory-keyword 0.940\nsection-cosine 0.810\nunion-rrf 0.905\n',
      'utf8',
    )
  }

  const supported = auditVerdictSupport({
    verdict: 'collapse',
    scores: [
      { arm: 'memory-keyword', precision: 0.94 },
      { arm: 'section-cosine', precision: 0.81 },
      { arm: 'union-rrf', precision: 0.905 },
    ],
    logPaths: [existingLog],
  })
  assert.equal(
    blockersFor(supported, 'verdict-support').length,
    0,
    'real scores plus an existing log path are enough support that collapse is at least inspectable',
  )
  assert.equal(
    auditProvenancePaths([existingLog]).filter((f) => isBlocker(f)).length,
    0,
    'an on-disk log path must pass the array-form provenance gate',
  )
})

test('staleness: a log older than its input script is not evidence', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'autoresearch-stale-'))
  const scriptPath = path.join(dir, 'compare.ts')
  const logPath = path.join(dir, 'compare.log')
  writeFileSync(scriptPath, '// input script\n', 'utf8')
  writeFileSync(logPath, 'stale or fresh log\n', 'utf8')

  try {
    const t0 = 1_700_000_000
    utimesSync(logPath, t0, t0)
    utimesSync(scriptPath, t0 + 60, t0 + 60)
    const stale = auditStaleness({
      logPaths: [logPath],
      inputScriptPaths: [scriptPath],
    })
    assert.ok(
      stale.some((f) => isBlocker(f) && hasGate(f, 'staleness')),
      'log mtime < input script mtime must BLOCK',
    )

    utimesSync(scriptPath, t0, t0)
    utimesSync(logPath, t0 + 60, t0 + 60)
    const fresh = auditStaleness({
      logPaths: [logPath],
      inputScriptPaths: [scriptPath],
    })
    assert.equal(
      fresh.filter((f) => isBlocker(f)).length,
      0,
      'a log newer than its input script is the reverse control and must not BLOCK',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('arm-distinctness: memory-hybrid and memory-keyword were the same arm on all 21 judged questions', () => {
  assert.equal(UNIT_IDS.length, 21)

  const collapsed = auditArmDistinctness(
    retrievalsFor([
      { armId: 'memory-keyword', units: UNIT_IDS, items: keywordItems },
      { armId: 'memory-hybrid', units: UNIT_IDS, items: keywordItems },
      { armId: 'sections', units: UNIT_IDS, items: sectionItems },
    ]),
  )
  const blockers = blockersFor(collapsed, 'arm-distinctness')
  assert.ok(
    blockers.length >= 1,
    'identical item ids on 21/21 units (the measured keyword≡hybrid incident) must BLOCK',
  )
  for (const finding of blockers) {
    const text = findingText(finding)
    assert.match(text, /memory-keyword/)
    assert.match(text, /memory-hybrid/)
    assert.equal(
      /sections/.test(text),
      false,
      'sections has a different item set on every unit and must not be reported against either memory arm',
    )
  }

  const partial = auditArmDistinctness(
    retrievalsFor([
      { armId: 'memory-keyword', units: UNIT_IDS, items: keywordItems },
      {
        armId: 'memory-hybrid',
        units: UNIT_IDS,
        items: (unitId) =>
          UNIT_IDS.indexOf(unitId) < 10 ? keywordItems(unitId) : hybridDiverged(unitId),
      },
    ]),
  )
  assert.equal(
    blockersFor(partial, 'arm-distinctness').length,
    0,
    'identical on 10/21 units (share 0.476) is below the 0.90 blocker threshold',
  )

  const thin = auditArmDistinctness(
    retrievalsFor([
      { armId: 'memory-keyword', units: UNIT_IDS.slice(0, 2), items: keywordItems },
      { armId: 'memory-hybrid', units: UNIT_IDS.slice(0, 2), items: keywordItems },
    ]),
  )
  assert.equal(
    blockersFor(thin, 'arm-distinctness').length,
    0,
    'fewer than 3 shared units is underpowered, not a collapse',
  )
  assert.ok(
    thin.some((f) => isNote(f) && hasGate(f, 'arm-distinctness')),
    'fewer than 3 shared units yields a note',
  )
})

test('verdictOf maps any blocker to no-finding, warnings-only to conditional, and clean to finding', () => {
  const blocker: Finding = {
    severity: 'blocker',
    gate: 'circularity',
    message: 'metric shares an objective with the memory arm',
  }
  const warning: Finding = {
    severity: 'warning',
    gate: 'degeneracy',
    message: '3 of 21 unit scores are exactly 0',
  }

  // verdictOf re-counts from findings; numeric blockers/warnings fields are ignored.
  const report = (findings: Finding[]): AuditReport => ({
    preregId: 'composition',
    findings,
    blockers: 0,
    warnings: 0,
  })

  assert.equal(verdictOf([blocker]), 'no-finding')
  assert.equal(verdictOf([blocker, warning]), 'no-finding')
  assert.equal(verdictOf([warning]), 'conditional')
  assert.equal(verdictOf([]), 'finding')
  assert.equal(verdictOf(report([blocker])), 'no-finding')
  assert.equal(verdictOf(report([blocker, warning])), 'no-finding')
  assert.equal(verdictOf(report([warning])), 'conditional')
  assert.equal(verdictOf(report([])), 'finding')
})

test('checkAgainstRefuted warns when a hypothesis restates that a cosine threshold separates matches', () => {
  const restated = checkAgainstRefuted(
    'A cosine threshold of 0.62 separates should-match from should-not-match pairs in this embedding space.',
  )
  assert.ok(
    restated.some((f) => isWarning(f) && hasGate(f, 'refuted')),
    'the overlap result (no scalar threshold separates matches) is a known-refuted claim',
  )

  const live = checkAgainstRefuted(
    'Honest out-of-archive abstention comes from keyword+IDF, not from claim embeddings.',
  )
  assert.equal(
    live.filter((f) => isWarning(f) || isBlocker(f)).length,
    0,
    'a hypothesis that does not restate a refuted claim must stay clean',
  )
})
