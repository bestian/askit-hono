/**
 * Audit a preregistration against a result bundle.
 * Local only: no network, no Cloudflare, no D1 / Vectorize / R2 / KV.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/autoresearch-audit.ts \
 *     --prereg local/cag-compare/prereg.json \
 *     --result local/cag-compare/result.json \
 *     --questions local/cag-compare/heldout-questions.json
 *
 * Exit 1 when any blocker is present, 0 otherwise. That exit code is the
 * enforcement: do not report the bundle as a finding if this process is red.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  audit,
  auditSample,
  checkAgainstRefuted,
  verdictOf,
  type ArmRetrieval,
  type ArmSpec,
  type FeatureTag,
  type Finding,
  type MetricSpec,
  type Prereg,
  type ResultBundle,
  type Severity,
  type UnitScore,
  type UniversalClaim,
} from '../src/utils/autoresearch'
import { auditLexicalInstrument } from '../src/utils/autoresearchInstrument'
import {
  auditBlindingFiles,
  auditProvenancePaths,
  auditStaleness,
  loadLexicalInstruments,
} from '../src/utils/autoresearchFs'

const FEATURE_TAGS: readonly FeatureTag[] = [
  'lexical-term',
  'lexical-phrase',
  'idf',
  'embedding-cosine',
  'rank-fusion',
  'graph-link',
  'recency',
  'human-label',
  'llm-judgement',
]

const CLAIM_KINDS = ['equality', 'implication'] as const

type Cli = {
  preregPath: string
  resultPath: string
  questionsPath: string
  json: boolean
}

type Boundary = Record<string, unknown>

function isBoundary(value: unknown): value is Boundary {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(pathName: string, message: string): never {
  throw new Error(`${pathName}: ${message}`)
}

function requireString(obj: Boundary, field: string, pathName: string): string {
  if (!(field in obj)) fail(pathName, `missing field ${field}`)
  const value = obj[field]
  if (typeof value !== 'string') fail(pathName, `field ${field} must be a string`)
  return value
}

function optionalString(obj: Boundary, field: string, pathName: string): string | undefined {
  if (!(field in obj)) return undefined
  const value = obj[field]
  if (typeof value !== 'string') fail(pathName, `field ${field} must be a string`)
  return value
}

function requireBoolean(obj: Boundary, field: string, pathName: string): boolean {
  if (!(field in obj)) fail(pathName, `missing field ${field}`)
  const value = obj[field]
  if (typeof value !== 'boolean') fail(pathName, `field ${field} must be a boolean`)
  return value
}

function requireNumber(obj: Boundary, field: string, pathName: string): number {
  if (!(field in obj)) fail(pathName, `missing field ${field}`)
  const value = obj[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(pathName, `field ${field} must be a finite number`)
  }
  return value
}

function requireStringArray(obj: Boundary, field: string, pathName: string): string[] {
  if (!(field in obj)) fail(pathName, `missing field ${field}`)
  const value = obj[field]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(pathName, `field ${field} must be an array of strings`)
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function isFeatureTag(value: unknown): value is FeatureTag {
  return typeof value === 'string' && (FEATURE_TAGS as readonly string[]).includes(value)
}

function parseFeatureTags(value: unknown, pathName: string, field: string): FeatureTag[] {
  if (!Array.isArray(value)) fail(pathName, `field ${field} must be an array`)
  const tags: FeatureTag[] = []
  for (const item of value) {
    if (!isFeatureTag(item)) {
      fail(pathName, `field ${field} contains an unknown FeatureTag`)
    }
    tags.push(item)
  }
  return tags
}

function parseArm(value: unknown, pathName: string, index: number): ArmSpec {
  const loc = `${pathName} arms[${index}]`
  if (!isBoundary(value)) fail(loc, 'must be an object')
  return {
    id: requireString(value, 'id', loc),
    rankingFeatures: parseFeatureTags(
      'rankingFeatures' in value ? value.rankingFeatures : undefined,
      loc,
      'rankingFeatures',
    ),
  }
}

function parseMetric(value: unknown, pathName: string): MetricSpec {
  const loc = `${pathName} metric`
  if (!isBoundary(value)) fail(pathName, 'missing field metric')
  return {
    id: requireString(value, 'id', loc),
    features: parseFeatureTags(
      'features' in value ? value.features : undefined,
      loc,
      'features',
    ),
    higherIsBetter: requireBoolean(value, 'higherIsBetter', loc),
    // Optional: declares that 0 is a legitimate observation (e.g. a win-rate
    // metric) so the degeneracy gate does not report a real outcome as a
    // broken scorer. Absent means false.
    zeroIsMeaningful:
      'zeroIsMeaningful' in value && value.zeroIsMeaningful === true,
  }
}

function parseCheapProbe(
  value: unknown,
  pathName: string,
): Prereg['cheapProbe'] {
  if (value === undefined) return undefined
  const loc = `${pathName} cheapProbe`
  if (!isBoundary(value)) fail(loc, 'must be an object')
  return {
    description: requireString(value, 'description', loc),
    costRatio: requireNumber(value, 'costRatio', loc),
  }
}

function parseBlinding(
  value: unknown,
  pathName: string,
): Prereg['blinding'] {
  if (value === undefined) return undefined
  const loc = `${pathName} blinding`
  if (!isBoundary(value)) fail(loc, 'must be an object')
  return {
    labelVocabulary: requireStringArray(value, 'labelVocabulary', loc),
    judgeVisiblePaths: requireStringArray(value, 'judgeVisiblePaths', loc),
  }
}

function parsePrereg(raw: unknown, pathName: string): Prereg {
  if (!isBoundary(raw)) fail(pathName, 'root must be an object')
  if (!('arms' in raw) || !Array.isArray(raw.arms)) {
    fail(pathName, 'missing field arms')
  }
  if (!('metric' in raw)) fail(pathName, 'missing field metric')
  const prereg: Prereg = {
    id: requireString(raw, 'id', pathName),
    question: requireString(raw, 'question', pathName),
    arms: raw.arms.map((arm, i) => parseArm(arm, pathName, i)),
    metric: parseMetric(raw.metric, pathName),
    unitIds: requireStringArray(raw, 'unitIds', pathName),
    acceptance: requireString(raw, 'acceptance', pathName),
    confounds: requireStringArray(raw, 'confounds', pathName),
  }
  const cheapProbe = parseCheapProbe(
    'cheapProbe' in raw ? raw.cheapProbe : undefined,
    pathName,
  )
  if (cheapProbe) prereg.cheapProbe = cheapProbe
  const blinding = parseBlinding(
    'blinding' in raw ? raw.blinding : undefined,
    pathName,
  )
  if (blinding) prereg.blinding = blinding
  return prereg
}

function parseScore(value: unknown, pathName: string, index: number): UnitScore {
  const loc = `${pathName} scores[${index}]`
  if (!isBoundary(value)) fail(loc, 'must be an object')
  return {
    unitId: requireString(value, 'unitId', loc),
    armId: requireString(value, 'armId', loc),
    value: requireNumber(value, 'value', loc),
  }
}

function parseResultBundle(raw: unknown, pathName: string): ResultBundle {
  if (!isBoundary(raw)) fail(pathName, 'root must be an object')
  if (!('scores' in raw) || !Array.isArray(raw.scores)) {
    fail(pathName, 'missing field scores')
  }
  const bundle: ResultBundle = {
    preregId: requireString(raw, 'preregId', pathName),
    scores: raw.scores.map((score, i) => parseScore(score, pathName, i)),
    logPaths: requireStringArray(raw, 'logPaths', pathName),
    inputScriptPaths: requireStringArray(raw, 'inputScriptPaths', pathName),
    producedBy: requireString(raw, 'producedBy', pathName),
  }
  const reproducedBy = optionalString(raw, 'reproducedBy', pathName)
  if (reproducedBy !== undefined) bundle.reproducedBy = reproducedBy
  const verdict = optionalString(raw, 'verdict', pathName)
  if (verdict !== undefined) bundle.verdict = verdict
  return bundle
}

function parseClaimKind(
  value: unknown,
  pathName: string,
): UniversalClaim['kind'] {
  if (typeof value !== 'string' || !(CLAIM_KINDS as readonly string[]).includes(value)) {
    fail(pathName, 'field kind must be "equality" or "implication"')
  }
  if (value === 'equality' || value === 'implication') return value
  fail(pathName, 'field kind must be "equality" or "implication"')
}

function parseUniversalClaim(value: unknown, pathName: string): UniversalClaim {
  if (!isBoundary(value)) fail(pathName, 'claim must be an object')
  return {
    statement: requireString(value, 'statement', pathName),
    kind: parseClaimKind('kind' in value ? value.kind : undefined, pathName),
    population: requireNumber(value, 'population', pathName),
    observed: requireNumber(value, 'observed', pathName),
  }
}

function parseRetrieval(value: unknown, pathName: string, index: number): ArmRetrieval {
  const loc = `${pathName} retrievals[${index}]`
  if (!isBoundary(value)) fail(loc, 'must be an object')
  return {
    armId: requireString(value, 'armId', loc),
    unitId: requireString(value, 'unitId', loc),
    itemIds: requireStringArray(value, 'itemIds', loc),
  }
}

function parseOptionalClaims(raw: Boundary, pathName: string): UniversalClaim[] {
  const claims: UniversalClaim[] = []
  if ('claim' in raw) claims.push(parseUniversalClaim(raw.claim, `${pathName} claim`))
  if ('universalClaim' in raw) {
    claims.push(parseUniversalClaim(raw.universalClaim, `${pathName} universalClaim`))
  }
  if ('claims' in raw) {
    if (!Array.isArray(raw.claims)) fail(pathName, 'field claims must be an array')
    raw.claims.forEach((item, i) => {
      claims.push(parseUniversalClaim(item, `${pathName} claims[${i}]`))
    })
  }
  return claims
}

function parseOptionalRetrievals(raw: Boundary, pathName: string): ArmRetrieval[] | undefined {
  if (!('retrievals' in raw)) return undefined
  if (!Array.isArray(raw.retrievals)) fail(pathName, 'field retrievals must be an array')
  return raw.retrievals.map((item, i) => parseRetrieval(item, pathName, i))
}

function readJson(filePath: string): unknown {
  const abs = path.resolve(filePath)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    fail(abs, `cannot read file (${reason})`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    fail(abs, `invalid JSON (${reason})`)
  }
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    preregPath: '',
    resultPath: '',
    questionsPath: '',
    json: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--json') {
      cli.json = true
      continue
    }
    if (a === '--prereg' || a === '--result' || a === '--questions') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) {
        fail('(argv)', `${a} requires a path`)
      }
      if (a === '--prereg') cli.preregPath = path.resolve(value)
      else if (a === '--result') cli.resultPath = path.resolve(value)
      else cli.questionsPath = path.resolve(value)
      continue
    }
    if (a.startsWith('--prereg=')) cli.preregPath = path.resolve(a.slice('--prereg='.length))
    else if (a.startsWith('--result=')) cli.resultPath = path.resolve(a.slice('--result='.length))
    else if (a.startsWith('--questions=')) cli.questionsPath = path.resolve(a.slice('--questions='.length))
    else if (a === '--help' || a === '-h') {
      process.stderr.write(
        'usage: autoresearch-audit --prereg <path> --result <path> [--questions <path>] [--json]\n',
      )
      process.exit(0)
    } else {
      fail('(argv)', `unknown flag ${a}`)
    }
  }
  if (!cli.preregPath) fail('(argv)', 'missing required flag --prereg <path>')
  if (!cli.resultPath) fail('(argv)', 'missing required flag --result <path>')
  return cli
}

function printHuman(findings: Finding[], verdict: ReturnType<typeof verdictOf>): void {
  const order: Severity[] = ['blocker', 'warning', 'note']
  for (const severity of order) {
    const group = findings.filter((f) => f.severity === severity)
    if (group.length === 0) continue
    process.stdout.write(`\n[${severity}]\n`)
    for (const f of group) {
      const units = f.unitIds && f.unitIds.length > 0 ? ` (${f.unitIds.join(', ')})` : ''
      process.stdout.write(`  ${f.gate}: ${f.message}${units}\n`)
    }
  }
  if (findings.length === 0) process.stdout.write('\n(no findings)\n')
  process.stdout.write(`\nverdict: ${verdict}\n`)
}

function main(): number {
  const cli = parseCli(process.argv.slice(2))
  const preregRaw = readJson(cli.preregPath)
  const resultRaw = readJson(cli.resultPath)
  const prereg = parsePrereg(preregRaw, cli.preregPath)
  const result = parseResultBundle(resultRaw, cli.resultPath)

  const extra: Finding[] = []
  extra.push(...auditProvenancePaths(result.logPaths))
  extra.push(
    ...auditStaleness({
      logPaths: result.logPaths,
      inputScriptPaths: result.inputScriptPaths,
    }),
  )
  if (prereg.blinding) extra.push(...auditBlindingFiles(prereg.blinding))
  extra.push(...checkAgainstRefuted(prereg.question))

  if (isBoundary(preregRaw)) {
    for (const claim of parseOptionalClaims(preregRaw, cli.preregPath)) {
      extra.push(...auditSample(claim))
    }
  }
  if (isBoundary(resultRaw)) {
    for (const claim of parseOptionalClaims(resultRaw, cli.resultPath)) {
      extra.push(...auditSample(claim))
    }
    const hypothesis = optionalString(resultRaw, 'hypothesis', cli.resultPath)
    if (hypothesis) extra.push(...checkAgainstRefuted(hypothesis))
  }

  if (cli.questionsPath) {
    extra.push(...auditLexicalInstrument(loadLexicalInstruments(cli.questionsPath)))
  }

  const retrievals = isBoundary(resultRaw)
    ? parseOptionalRetrievals(resultRaw, cli.resultPath)
    : undefined
  const report = audit(prereg, result, extra, retrievals)
  const verdict = verdictOf(report)

  if (cli.json) {
    process.stdout.write(`${JSON.stringify({ ...report, verdict }, null, 2)}\n`)
  } else {
    printHuman(report.findings, verdict)
  }
  return report.blockers > 0 ? 1 : 0
}

try {
  process.exit(main())
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
