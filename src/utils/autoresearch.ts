export type FeatureTag =
  | 'lexical-term'
  | 'lexical-phrase'
  | 'idf'
  | 'embedding-cosine'
  | 'rank-fusion'
  | 'graph-link'
  | 'recency'
  | 'human-label'
  | 'llm-judgement'

export type FeatureFamily = 'lexical' | 'vector' | 'fusion' | 'structural' | 'human'

export const FEATURE_FAMILY: Record<FeatureTag, FeatureFamily> = {
  'lexical-term': 'lexical',
  'lexical-phrase': 'lexical',
  idf: 'lexical',
  'embedding-cosine': 'vector',
  'rank-fusion': 'fusion',
  'graph-link': 'structural',
  recency: 'structural',
  'human-label': 'human',
  'llm-judgement': 'human',
}

export type Severity = 'blocker' | 'warning' | 'note'
export type Finding = {
  severity: Severity
  gate: string
  message: string
  unitIds?: string[]
  path?: string
}

export type ArmSpec = { id: string; rankingFeatures: FeatureTag[] }
export type MetricSpec = {
  id: string
  features: FeatureTag[]
  higherIsBetter: boolean
  /**
   * Set when 0 is a legitimate observation rather than a scorer failure — e.g. a
   * win-rate metric where losing every pairing genuinely scores 0. Suppresses the
   * degeneracy gate, which otherwise reports a real outcome as a broken scorer.
   */
  zeroIsMeaningful?: boolean
}

export type Prereg = {
  id: string
  question: string
  arms: ArmSpec[]
  metric: MetricSpec
  unitIds: string[]
  acceptance: string
  confounds: string[]
  cheapProbe?: { description: string; costRatio: number }
  blinding?: { labelVocabulary: string[]; judgeVisiblePaths: string[] }
}

export type UnitScore = { unitId: string; armId: string; value: number }

export type ResultBundle = {
  preregId: string
  scores: UnitScore[]
  logPaths: string[]
  inputScriptPaths: string[]
  producedBy: string
  reproducedBy?: string
  verdict?: string
}

export type UniversalClaim = {
  statement: string
  kind: 'equality' | 'implication'
  population: number
  observed: number
}

export type RefutedHypothesis = {
  id: string
  statement: string
  refutedBy: string
  evidence: string
  date: string
}

export type AuditReport = {
  preregId: string
  findings: Finding[]
  blockers: number
  warnings: number
}

export type ArmRetrieval = { armId: string; unitId: string; itemIds: string[] }

export const KNOWN_REFUTED: readonly RefutedHypothesis[] = [
  {
    id: 'cosine-cannot-gate',
    statement:
      'a scalar cosine threshold can separate should-match from should-not-match in the claim-embedding space',
    refutedBy: '21×96 pair-sample overlap in qwen3 claim-embedding space',
    evidence:
      '21×96 pair sample, should-match median 0.466 / p90 0.634 / max 0.683 vs should-NOT-match median 0.335 / p90 0.429 / max 0.618, distributions overlap 0.264–0.618',
    date: '2026-08-16',
  },
  {
    id: 'punct-to-hyphen-fold',
    statement: 'archive.tw slugs fold CJK punctuation to hyphens',
    refutedBy: '105-room archive.tw slug-fold audit',
    evidence: 'recovered 0 of 56 rooms; deleting the punctuation recovered 15',
    date: '2026-08-17',
  },
  {
    id: 'absent-ngram-implies-absent-topic',
    statement:
      'absence of a query n-gram from the corpus indicates the topic is absent',
    refutedBy: 'held-out in-corpus vs out-of-archive absent-n-gram lengths',
    evidence:
      'held-out in-corpus questions had LONGER absent n-grams (mean 5.33) than genuinely out-of-archive ones (4.11); the rule would abstain on 85% of answerable questions',
    date: '2026-08-17',
  },
  {
    id: 'claim-embeddings-beat-chunks',
    statement:
      'embedding a distilled claim retrieves better than embedding a raw chunk',
    refutedBy: 'memory-cosine vs section-cosine isolate at 6 and 105 rooms',
    evidence:
      'memory-cosine 0.690 vs section-cosine 0.810, reproduced in every run at 6 rooms and 105 rooms',
    date: '2026-08-17',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFeatureTag(value: unknown): FeatureTag | null {
  if (value === 'lexical-term') return 'lexical-term'
  if (value === 'lexical-phrase') return 'lexical-phrase'
  if (value === 'idf') return 'idf'
  if (value === 'embedding-cosine') return 'embedding-cosine'
  if (value === 'rank-fusion') return 'rank-fusion'
  if (value === 'graph-link') return 'graph-link'
  if (value === 'recency') return 'recency'
  if (value === 'human-label') return 'human-label'
  if (value === 'llm-judgement') return 'llm-judgement'
  return null
}

function readFeatureTags(value: unknown): FeatureTag[] {
  if (!Array.isArray(value)) return []
  const out: FeatureTag[] = []
  for (const item of value) {
    const tag = asFeatureTag(item)
    if (tag) out.push(tag)
  }
  return out
}

function familiesOfTags(tags: readonly FeatureTag[]): Set<FeatureFamily> {
  const out = new Set<FeatureFamily>()
  for (const tag of tags) out.add(FEATURE_FAMILY[tag])
  return out
}

function isSubset<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) {
    if (!b.has(x)) return false
  }
  return true
}

function intersects<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) {
    if (b.has(x)) return true
  }
  return false
}

function formatFamilySet(families: Set<FeatureFamily>): string {
  return [...families].join(',')
}

function formatRatio(numer: number, denom: number): string {
  if (denom <= 0) return `${numer}/${denom}`
  return `${numer}/${denom} (${(numer / denom).toFixed(3)})`
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function ownFamilies(arm: ArmSpec): Set<FeatureFamily> {
  return familiesOfTags(arm.rankingFeatures)
}

function effectiveFamilies(arm: ArmSpec, arms: readonly ArmSpec[]): Set<FeatureFamily> {
  const own = ownFamilies(arm)
  // 'fusion' rule: an arm including rank-fusion inherits the families of the
  // other arms, so it matches any family and can never be the orthogonal arm B
  // in the circularity blocker.
  if (!arm.rankingFeatures.includes('rank-fusion')) return own
  for (const other of arms) {
    if (other.id === arm.id) continue
    for (const tag of other.rankingFeatures) {
      if (tag === 'rank-fusion') continue
      own.add(FEATURE_FAMILY[tag])
    }
  }
  return own
}

function normalizeArms(input: unknown): ArmSpec[] {
  if (Array.isArray(input)) {
    const out: ArmSpec[] = []
    for (const item of input) {
      if (!isRecord(item)) continue
      const id = typeof item.id === 'string' ? item.id : ''
      const rankingFeatures = readFeatureTags(
        item.rankingFeatures ?? item.features ?? item.tags,
      )
      if (id) out.push({ id, rankingFeatures })
    }
    return out
  }
  if (!isRecord(input)) return []
  const out: ArmSpec[] = []
  for (const [id, tags] of Object.entries(input)) {
    out.push({ id, rankingFeatures: readFeatureTags(tags) })
  }
  return out
}

function normalizeMetric(input: unknown): MetricSpec {
  if (Array.isArray(input)) {
    const features = readFeatureTags(input)
    return { id: features.join('+') || 'metric', features, higherIsBetter: true }
  }
  if (typeof input === 'string') {
    const tag = asFeatureTag(input)
    const features = tag ? [tag] : []
    return { id: input, features, higherIsBetter: true }
  }
  if (isRecord(input)) {
    const features = readFeatureTags(input.features ?? input.tags ?? input.metric)
    const id = typeof input.id === 'string' ? input.id : features.join('+') || 'metric'
    return {
      id,
      features,
      higherIsBetter: input.higherIsBetter !== false,
      zeroIsMeaningful: input.zeroIsMeaningful === true,
    }
  }
  return { id: 'metric', features: [], higherIsBetter: true }
}

function normalizePrereg(input: unknown): Prereg {
  if (!isRecord(input)) {
    return {
      id: '',
      question: '',
      arms: [],
      metric: { id: 'metric', features: [], higherIsBetter: true },
      unitIds: [],
      acceptance: '',
      confounds: [],
    }
  }
  const metric = normalizeMetric(input.metric)
  const arms = normalizeArms(input.arms)
  return {
    id: typeof input.id === 'string' ? input.id : '',
    question: typeof input.question === 'string' ? input.question : '',
    arms,
    metric,
    unitIds: Array.isArray(input.unitIds)
      ? input.unitIds.filter((id): id is string => typeof id === 'string')
      : [],
    acceptance: typeof input.acceptance === 'string' ? input.acceptance : '',
    confounds: Array.isArray(input.confounds)
      ? input.confounds.filter((c): c is string => typeof c === 'string')
      : [],
    cheapProbe: isRecord(input.cheapProbe)
      ? {
          description: String(input.cheapProbe.description ?? ''),
          costRatio: Number(input.cheapProbe.costRatio),
        }
      : undefined,
    blinding: isRecord(input.blinding)
      ? {
          labelVocabulary: Array.isArray(input.blinding.labelVocabulary)
            ? input.blinding.labelVocabulary.filter((v): v is string => typeof v === 'string')
            : [],
          judgeVisiblePaths: Array.isArray(input.blinding.judgeVisiblePaths)
            ? input.blinding.judgeVisiblePaths.filter((v): v is string => typeof v === 'string')
            : [],
        }
      : undefined,
  }
}

function scoreValue(row: Record<string, unknown>): number {
  const raw = row.value ?? row.score ?? row.precision
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NaN
}

function scoreArmId(row: Record<string, unknown>, fallback: string): string {
  if (typeof row.armId === 'string') return row.armId
  if (typeof row.arm === 'string') return row.arm
  return fallback
}

function scoreUnitId(row: Record<string, unknown>, index: number): string {
  if (typeof row.unitId === 'string') return row.unitId
  if (typeof row.id === 'string') return row.id
  return `unit-${index}`
}

function normalizeScores(input: unknown, fallbackArm: string): UnitScore[] {
  if (!Array.isArray(input)) return []
  const out: UnitScore[] = []
  for (let i = 0; i < input.length; i++) {
    const row = input[i]
    if (!isRecord(row)) continue
    const value = scoreValue(row)
    out.push({
      unitId: scoreUnitId(row, i),
      armId: scoreArmId(row, fallbackArm),
      value: Number.isFinite(value) ? value : 0,
    })
  }
  return out
}

function normalizeResult(input: unknown): ResultBundle {
  if (!isRecord(input)) {
    return {
      preregId: '',
      scores: [],
      logPaths: [],
      inputScriptPaths: [],
      producedBy: '',
    }
  }
  const fallbackArm = typeof input.arm === 'string' ? input.arm : ''
  return {
    preregId: typeof input.preregId === 'string' ? input.preregId : '',
    scores: normalizeScores(input.scores, fallbackArm),
    logPaths: Array.isArray(input.logPaths)
      ? input.logPaths.filter((p): p is string => typeof p === 'string')
      : typeof input.logPath === 'string'
        ? [input.logPath]
        : [],
    inputScriptPaths: Array.isArray(input.inputScriptPaths)
      ? input.inputScriptPaths.filter((p): p is string => typeof p === 'string')
      : [],
    producedBy: typeof input.producedBy === 'string' ? input.producedBy : '',
    reproducedBy: typeof input.reproducedBy === 'string' ? input.reproducedBy : undefined,
    verdict: typeof input.verdict === 'string' ? input.verdict : undefined,
  }
}

function normalizeClaim(input: unknown): UniversalClaim {
  if (!isRecord(input)) {
    return { statement: '', kind: 'equality', population: 0, observed: 0 }
  }
  return {
    statement: typeof input.statement === 'string' ? input.statement : '',
    kind: input.kind === 'implication' ? 'implication' : 'equality',
    population: typeof input.population === 'number' ? input.population : 0,
    observed: typeof input.observed === 'number' ? input.observed : 0,
  }
}

export function auditCircularity(p: Prereg | Record<string, unknown>): Finding[] {
  const prereg = normalizePrereg(p)
  const metricFamilies = familiesOfTags(prereg.metric.features)
  const byArm = prereg.arms.map((arm) => ({
    id: arm.id,
    own: ownFamilies(arm),
    effective: effectiveFamilies(arm, prereg.arms),
    fusion: arm.rankingFeatures.includes('rank-fusion'),
  }))

  const findings: Finding[] = []
  for (const a of byArm) {
    // Fusion arms inherit other families, so they are never a pure objective
    // match for A; using own families keeps rank-fusion from becoming A.
    if (a.fusion || metricFamilies.size === 0 || !isSubset(metricFamilies, a.own)) {
      continue
    }
    for (const b of byArm) {
      if (b.id === a.id) continue
      if (intersects(metricFamilies, b.effective)) continue
      findings.push({
        severity: 'blocker',
        gate: 'circularity',
        message: `metric ${prereg.metric.id} families {${formatFamilySet(metricFamilies)}} ⊆ arm ${a.id} {${formatFamilySet(a.own)}} and are orthogonal to arm ${b.id} {${formatFamilySet(b.effective) || '∅'}}; the metric is made of ${a.id}'s objective and cannot compare ${a.id} against ${b.id}`,
      })
    }
  }
  if (findings.length > 0) return findings

  let overlapCount = 0
  const overlapping: string[] = []
  const disjoint: string[] = []
  for (const arm of byArm) {
    if (intersects(metricFamilies, arm.effective)) {
      overlapCount += 1
      overlapping.push(arm.id)
    } else {
      disjoint.push(arm.id)
    }
  }
  if (overlapCount > 0 && overlapCount < byArm.length) {
    findings.push({
      severity: 'warning',
      gate: 'circularity',
      message: `metric ${prereg.metric.id} overlaps ${overlapCount}/${byArm.length} arms (${overlapping.join(', ')}) and is disjoint from ${disjoint.join(', ') || 'none'}`,
    })
  }
  return findings
}

export function auditDegeneracy(
  r: ResultBundle | Record<string, unknown>,
  opts?: { zeroShare?: number; saturationValue?: number },
): Finding[] {
  const result = normalizeResult(r)
  const zeroShare = opts?.zeroShare ?? 0.1
  const saturationValue = opts?.saturationValue
  const byArm = new Map<string, UnitScore[]>()
  for (const score of result.scores) {
    const list = byArm.get(score.armId)
    if (list) list.push(score)
    else byArm.set(score.armId, [score])
  }

  const findings: Finding[] = []
  for (const [armId, rows] of byArm) {
    if (rows.length === 0) continue
    const zeros = rows.filter((row) => row.value === 0)
    const share = zeros.length / rows.length
    const nonzero = rows.filter((row) => row.value !== 0).map((row) => row.value)
    const nonzeroMean = mean(nonzero)
    if (share >= zeroShare && nonzeroMean !== null && nonzeroMean > 0.5) {
      findings.push({
        severity: 'warning',
        gate: 'degeneracy',
        message: `arm ${armId} has ${zeros.length}/${rows.length} exact-0 scores (${share.toFixed(3)} ≥ ${zeroShare}); non-zero mean ${nonzeroMean.toFixed(3)} > 0.5 — a zero cluster beside healthy scores indicates scorer failure, not absent material`,
        unitIds: zeros.map((row) => row.unitId),
      })
    }
    if (saturationValue !== undefined) {
      const sat = rows.filter((row) => row.value === saturationValue)
      const satShare = sat.length / rows.length
      if (satShare >= 0.8) {
        findings.push({
          severity: 'warning',
          gate: 'degeneracy',
          message: `arm ${armId} has ${sat.length}/${rows.length} values equal to saturationValue ${saturationValue} (${satShare.toFixed(3)} ≥ 0.800); this measures limit saturation, not signal`,
          unitIds: sat.map((row) => row.unitId),
        })
      }
    }
  }
  return findings
}

export function auditSample(
  c: UniversalClaim | Record<string, unknown>,
  opts?: { minObserved?: number; minCoverage?: number },
): Finding[] {
  const claim = normalizeClaim(c)
  const minObserved = opts?.minObserved ?? 5
  const minCoverage = opts?.minCoverage ?? 0.05
  const coverage = claim.population > 0 ? claim.observed / claim.population : 0
  if (claim.observed < minObserved || coverage < minCoverage) {
    const coverageText =
      claim.population > 0 ? coverage.toFixed(3) : 'undefined (population 0)'
    return [
      {
        severity: 'blocker',
        gate: 'sample',
        message: `universal ${claim.kind} claim ${JSON.stringify(claim.statement)} rests on observed ${claim.observed} of population ${claim.population} (coverage ${coverageText}); need observed ≥ ${minObserved} and coverage ≥ ${minCoverage}`,
      },
    ]
  }
  return []
}

export function auditReproduction(r: ResultBundle | Record<string, unknown>): Finding[] {
  const result = normalizeResult(r)
  const reproduced = result.reproducedBy?.trim() ?? ''
  if (reproduced.length === 0 || reproduced === result.producedBy) {
    return [
      {
        severity: 'warning',
        gate: 'reproduction',
        message:
          reproduced.length === 0
            ? `result ${result.preregId} producedBy ${JSON.stringify(result.producedBy)} has no reproducedBy`
            : `result ${result.preregId} reproducedBy ${JSON.stringify(reproduced)} equals producedBy ${JSON.stringify(result.producedBy)}`,
      },
    ]
  }
  return []
}

export function auditVerdictSupport(r: ResultBundle | Record<string, unknown>): Finding[] {
  const result = normalizeResult(r)
  const verdict = result.verdict?.trim() ?? ''
  if (verdict.length === 0) return []
  const findings: Finding[] = []
  if (result.scores.length === 0) {
    findings.push({
      severity: 'blocker',
      gate: 'verdict-support',
      message: `verdict ${JSON.stringify(verdict)} is unsupported: scores length 0`,
    })
  }
  if (result.logPaths.length === 0) {
    findings.push({
      severity: 'blocker',
      gate: 'verdict-support',
      message: `verdict ${JSON.stringify(verdict)} is unsupported: logPaths length 0`,
    })
  }
  return findings
}

export function auditCheapProbe(p: Prereg | Record<string, unknown>): Finding[] {
  const prereg = normalizePrereg(p)
  if (prereg.cheapProbe === undefined) {
    return [
      {
        severity: 'note',
        gate: 'cheap-probe',
        message: `prereg ${prereg.id} declares no cheapProbe`,
      },
    ]
  }
  if (prereg.cheapProbe.costRatio > 0.1) {
    return [
      {
        severity: 'warning',
        gate: 'cheap-probe',
        message: `prereg ${prereg.id} cheapProbe costRatio ${prereg.cheapProbe.costRatio} > 0.1 (${JSON.stringify(prereg.cheapProbe.description)}); no cheap falsification path was run before an expensive one`,
      },
    ]
  }
  return []
}

function statementKeywords(statement: string): string[] {
  const parts = statement.toLowerCase().match(/[a-z0-9][a-z0-9.'-]+|[\u4e00-\u9fff]+/g)
  if (parts === null) return []
  const out: string[] = []
  for (const part of parts) {
    if (part.length >= 4) out.push(part)
  }
  return out
}

function hypothesisMatchesStatement(hypothesis: string, statement: string): boolean {
  const h = hypothesis.toLowerCase()
  const s = statement.toLowerCase()
  if (h.includes(s) || s.includes(h)) return true
  const keywords = statementKeywords(statement)
  if (keywords.length === 0) return false
  let hits = 0
  for (const word of keywords) {
    if (h.includes(word)) hits += 1
  }
  return hits >= 2 && hits / keywords.length >= 0.4
}

export function checkAgainstRefuted(
  hypothesis: string,
  registry?: readonly RefutedHypothesis[],
): Finding[] {
  const entries = registry ?? KNOWN_REFUTED
  const findings: Finding[] = []
  for (const entry of entries) {
    if (!hypothesisMatchesStatement(hypothesis, entry.statement)) continue
    findings.push({
      severity: 'warning',
      gate: 'refuted',
      message: `hypothesis matches refuted ${entry.id} (${entry.date}): ${entry.statement}; evidence: ${entry.evidence}`,
    })
  }
  return findings
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size !== right.size) return false
  for (const id of left) {
    if (!right.has(id)) return false
  }
  return true
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function auditArmDistinctness(
  retrievals: ArmRetrieval[],
  opts?: { maxIdenticalShare?: number },
): Finding[] {
  const maxIdenticalShare = opts?.maxIdenticalShare ?? 0.9
  const byUnit = new Map<string, Map<string, string[]>>()
  const armOrder: string[] = []
  const seenArms = new Set<string>()
  for (const row of retrievals) {
    if (!seenArms.has(row.armId)) {
      seenArms.add(row.armId)
      armOrder.push(row.armId)
    }
    let arms = byUnit.get(row.unitId)
    if (!arms) {
      arms = new Map()
      byUnit.set(row.unitId, arms)
    }
    arms.set(row.armId, row.itemIds)
  }

  const findings: Finding[] = []
  for (let i = 0; i < armOrder.length; i++) {
    for (let j = i + 1; j < armOrder.length; j++) {
      const a = armOrder[i]
      const b = armOrder[j]
      const shared: string[] = []
      const setIdentical: string[] = []
      let orderIdentical = 0
      for (const [unitId, arms] of byUnit) {
        const left = arms.get(a)
        const right = arms.get(b)
        if (left === undefined || right === undefined) continue
        shared.push(unitId)
        if (sameSet(left, right)) {
          setIdentical.push(unitId)
          if (sameOrder(left, right)) orderIdentical += 1
        }
      }
      if (shared.length < 3) {
        findings.push({
          severity: 'note',
          gate: 'arm-distinctness',
          message: `arms ${a} and ${b} share ${shared.length} units (< 3); too little overlap to judge distinctness`,
          unitIds: shared,
        })
        continue
      }
      const setShare = setIdentical.length / shared.length
      const orderShare = orderIdentical / shared.length
      const base =
        `arms ${a} and ${b} are set-identical on ${formatRatio(setIdentical.length, shared.length)} shared units` +
        `; order-identical ${formatRatio(orderIdentical, shared.length)} (share ${orderShare.toFixed(3)})`
      if (setShare >= maxIdenticalShare) {
        findings.push({
          severity: 'blocker',
          gate: 'arm-distinctness',
          message: `${base} ≥ ${maxIdenticalShare}; the arms are not distinct on this unit set, so any per-arm comparison between them is vacuous`,
          unitIds: setIdentical,
        })
      } else if (setShare >= 0.6) {
        findings.push({
          severity: 'warning',
          gate: 'arm-distinctness',
          message: `${base} ≥ 0.60 and < ${maxIdenticalShare}`,
          unitIds: setIdentical,
        })
      }
    }
  }
  return findings
}

export function audit(
  p: Prereg | Record<string, unknown>,
  r: ResultBundle | Record<string, unknown>,
  extra?: Finding[],
  retrievals?: ArmRetrieval[],
): AuditReport {
  const prereg = normalizePrereg(p)
  const result = normalizeResult(r)
  const findings: Finding[] = [
    ...auditCircularity(prereg),
    ...(prereg.metric.zeroIsMeaningful === true ? [] : auditDegeneracy(result)),
    ...auditReproduction(result),
    ...auditVerdictSupport(result),
    ...auditCheapProbe(prereg),
    ...checkAgainstRefuted(`${prereg.question}\n${prereg.acceptance}`),
    ...(retrievals === undefined ? [] : auditArmDistinctness(retrievals)),
    ...(extra ?? []),
  ]
  let blockers = 0
  let warnings = 0
  for (const finding of findings) {
    const severity = String(finding.severity).toLowerCase()
    if (severity === 'blocker') blockers += 1
    else if (severity === 'warning') warnings += 1
  }
  return { preregId: prereg.id, findings, blockers, warnings }
}

function findingsOf(report: AuditReport | readonly Finding[]): Finding[] {
  // `in` narrows the union: a readonly Finding[] never declares `findings`.
  if ('findings' in report) return [...report.findings]
  return [...report]
}

export function verdictOf(
  report: AuditReport | readonly Finding[],
): 'finding' | 'conditional' | 'no-finding' {
  const findings = findingsOf(report)
  let blockers = 0
  let warnings = 0
  for (const finding of findings) {
    const severity = String(finding.severity).toLowerCase()
    if (severity === 'blocker') blockers += 1
    else if (severity === 'warning') warnings += 1
  }
  if (blockers > 0) return 'no-finding'
  if (warnings > 0) return 'conditional'
  return 'finding'
}
