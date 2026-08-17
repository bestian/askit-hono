import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import type { Finding } from './autoresearch'
import type { LexicalInstrument } from './autoresearchInstrument'

export function auditProvenancePaths(logPaths: readonly string[]): Finding[] {
  const findings: Finding[] = []
  for (const raw of logPaths) {
    const filePath = resolvePath(raw)
    if (!existsSync(filePath)) {
      findings.push(
        finding(
          'blocker',
          'provenance',
          `${filePath}: declared log path is missing`,
          filePath,
        ),
      )
    }
  }
  return findings
}

export function auditStaleness(input: {
  logPath?: string
  logPaths?: readonly string[]
  inputScriptPath?: string
  inputScriptPaths?: readonly string[]
  inputPaths?: readonly string[]
}): Finding[] {
  const findings: Finding[] = []
  const logPaths = collectPaths(input.logPath, input.logPaths)
  const scriptPaths = collectPaths(
    input.inputScriptPath,
    input.inputScriptPaths,
    input.inputPaths,
  )

  for (const rawLog of logPaths) {
    const logPath = resolvePath(rawLog)
    if (!existsSync(logPath)) continue
    const logStat = statSync(logPath)
    if (!logStat.isFile()) continue

    for (const rawScript of scriptPaths) {
      const scriptPath = resolvePath(rawScript)
      if (!existsSync(scriptPath)) continue
      const scriptStat = statSync(scriptPath)
      if (logStat.mtimeMs < scriptStat.mtimeMs) {
        findings.push(
          finding(
            'blocker',
            'staleness',
            `${logPath}: log mtime is older than input script ${scriptPath}`,
            logPath,
          ),
        )
      }
    }
  }
  return findings
}

export function auditBlindingFiles(input: {
  labelVocabulary: readonly string[]
  judgeVisiblePaths: readonly string[]
}): Finding[] {
  const findings: Finding[] = []
  for (const raw of input.judgeVisiblePaths) {
    const filePath = resolvePath(raw)
    if (!existsSync(filePath)) {
      findings.push(
        finding(
          'warning',
          'blinding',
          `${filePath}: judge-visible file is missing`,
          filePath,
        ),
      )
      continue
    }
    const text = readFileSync(filePath, 'utf8')
    for (const label of input.labelVocabulary) {
      if (label.length === 0) continue
      if (text.includes(label)) {
        findings.push(
          finding(
            'blocker',
            'blinding',
            `${filePath}: judge-visible file contains ${label}`,
            filePath,
          ),
        )
      }
    }
  }
  return findings
}

export function loadLexicalInstruments(filePath: string): LexicalInstrument[] {
  const resolved = resolvePath(filePath)
  if (!existsSync(resolved)) {
    throw new Error(`${resolved}: file does not exist`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'JSON.parse failed'
    throw new Error(`${resolved}: invalid JSON (${detail})`)
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${resolved}: expected a JSON object`)
  }

  const units = readUnitArray(parsed, resolved)
  const instruments: LexicalInstrument[] = []
  for (let i = 0; i < units.length; i++) {
    instruments.push(readInstrument(units[i], resolved, i))
  }
  return instruments
}

function collectPaths(
  singular?: string,
  ...lists: Array<readonly string[] | undefined>
): string[] {
  const out: string[] = []
  if (singular !== undefined) out.push(singular)
  for (const list of lists) {
    if (list === undefined) continue
    for (const p of list) out.push(p)
  }
  return out
}

function readUnitArray(parsed: object, filePath: string): unknown[] {
  if ('cases' in parsed) {
    const cases = parsed.cases
    if (!Array.isArray(cases)) {
      throw new Error(`${filePath}: "cases" is present but is not an array`)
    }
    return cases
  }
  if ('questions' in parsed) {
    const questions = parsed.questions
    if (!Array.isArray(questions)) {
      throw new Error(`${filePath}: "questions" is present but is not an array`)
    }
    return questions
  }
  throw new Error(`${filePath}: missing "cases" or "questions" array`)
}

function readInstrument(
  unit: unknown,
  filePath: string,
  index: number,
): LexicalInstrument {
  const loc = `${filePath}: unit[${index}]`
  if (typeof unit !== 'object' || unit === null) {
    throw new Error(`${loc}: expected an object`)
  }

  const id = readUnitId(unit, loc)
  const terms = readUnitTerms(unit, loc)
  return { unitId: id, terms }
}

function readUnitId(unit: object, loc: string): string {
  if ('id' in unit && typeof unit.id === 'string' && unit.id.length > 0) {
    return unit.id
  }
  if (
    'questionId' in unit &&
    typeof unit.questionId === 'string' &&
    unit.questionId.length > 0
  ) {
    return unit.questionId
  }
  throw new Error(`${loc}: missing non-empty "id" or "questionId"`)
}

function readUnitTerms(unit: object, loc: string): string[] {
  const fromTopic = optionalTermList(unit, 'topicTerms', loc)
  if (fromTopic !== null) return fromTopic
  const fromAbsent = optionalTermList(unit, 'absentTerms', loc)
  if (fromAbsent !== null) return fromAbsent
  const fromPresent = optionalTermList(unit, 'presentTerms', loc)
  if (fromPresent !== null) return fromPresent
  throw new Error(`${loc}: missing non-empty "topicTerms" or "absentTerms"`)
}

function optionalTermList(
  unit: object,
  field: 'topicTerms' | 'absentTerms' | 'presentTerms',
  loc: string,
): string[] | null {
  if (!(field in unit)) return null
  // Spread to a string-keyed record so a dynamic field name reads as `unknown`
  // without asserting a shape onto `unit`.
  const record: Record<string, unknown> = { ...unit }
  const value = record[field]
  if (!Array.isArray(value)) {
    throw new Error(`${loc}: "${field}" is not an array`)
  }
  if (value.length === 0) return null
  return readTermList(value, loc, field)
}

function readTermList(value: unknown, loc: string, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${loc}: "${field}" is not an array`)
  }
  const terms: string[] = []
  for (let i = 0; i < value.length; i++) {
    const term = value[i]
    if (typeof term !== 'string' || term.length === 0) {
      throw new Error(`${loc}: "${field}[${i}]" is not a non-empty string`)
    }
    terms.push(term)
  }
  if (terms.length === 0) {
    throw new Error(`${loc}: "${field}" is empty`)
  }
  return terms
}

function resolvePath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(filePath)
}

function finding(
  severity: 'blocker' | 'warning',
  gate: 'provenance' | 'staleness' | 'blinding',
  message: string,
  filePath: string,
): Finding {
  return { severity, gate, message, path: filePath }
}
