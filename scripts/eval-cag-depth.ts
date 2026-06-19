/**
 * Honest CAG/Audrey depth eval: production-shaped Vectorize thin vs
 * archive-hydrated sources.
 *
 * Usage:
 *   npm run eval:cag:depth
 *   npm run eval:cag:depth -- --mode=thin
 *   npm run eval:cag:depth -- --mode=hydrate
 *   npm run eval:cag:depth -- --cases=digital-signature,ai-governance
 *   npm run eval:cag:depth -- --audrey --mode=hydrate --model=gemma
 *   npm run eval:cag:depth -- --audrey --mode=hydrate --model=glm-5.2
 */
import { execSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

import {
  buildCagMessages,
  completeCagAnswer,
  DEFAULT_TOP_K,
  detectCagAnswerLanguage,
  hydrateCagSourcesFromArchive,
  type CagSource,
} from '../src/utils/cag'
import {
  buildAudreySkillAnswerInstruction,
  resolveAudreySkillModel,
} from '../src/utils/audreySkill'
import {
  CAG_MODEL_GEMMA,
  DEFAULT_AUDREY_EVAL_CASES,
  DEFAULT_CAG_EVAL_CASES,
  scoreCagAnswer,
  scoreCagDepth,
  type CagEvalCase,
} from '../src/utils/cagEval'
import {
  DEFAULT_VECTORIZE_MIN_COSINE_SCORE,
  retrieveCagSourcesFromVectorize,
  VECTORIZE_INDEX_NAME,
  type VectorizeBinding,
} from '../src/utils/vectorize'

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

type WorkersAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>
}

type EvalArm = 'thin' | 'hydrate'
type EvalProfile = 'cag' | 'audrey'

type EvalGenerateOptions = {
  profile: EvalProfile
  model: string
}

type CaseArmResult = {
  arm: EvalArm
  caseId: string
  sourceCount: number
  passed: boolean
  shallow: boolean
  answerChars: number
  groundingScore: number
  totalSourceChars: number
  retrievalMs: number
  hydrateMs: number
  generateMs: number
  answerPreview: string
  answerFull: string
}

type CompareCaseResult = {
  caseId: string
  thin: CaseArmResult | null
  hydrate: CaseArmResult | null
}

function parseCaseFilter(argv: string[]): string[] | null {
  const flag = argv.find((arg) => arg.startsWith('--cases='))
  if (!flag) return null
  return flag.slice('--cases='.length).split(',').map((id) => id.trim()).filter(Boolean)
}

function parseFullAnswers(argv: string[]): boolean {
  return argv.includes('--full')
}

function parseMode(argv: string[]): EvalArm | 'compare' {
  const flag = argv.find((arg) => arg.startsWith('--mode='))
  if (!flag) return 'compare'
  const mode = flag.slice('--mode='.length)
  if (mode === 'thin' || mode === 'hydrate' || mode === 'compare') return mode
  throw new Error(`Unknown --mode=${mode}. Use thin, hydrate, or compare.`)
}

function parseProfile(argv: string[]): EvalProfile {
  return argv.includes('--audrey') || argv.includes('--profile=audrey')
    ? 'audrey'
    : 'cag'
}

function parseModel(argv: string[], profile: EvalProfile): string {
  const flag = argv.find((arg) => arg.startsWith('--model='))
  const raw = flag?.slice('--model='.length)
  if (profile === 'cag') return CAG_MODEL_GEMMA
  if (!raw) return resolveAudreySkillModel(process.env.AUDREY_MODEL)
  if (raw === 'gemma') return resolveAudreySkillModel(CAG_MODEL_GEMMA)
  if (raw === 'glm' || raw === 'glm-5.2') {
    return resolveAudreySkillModel('@cf/zai-org/glm-5.2')
  }
  return resolveAudreySkillModel(raw)
}

function resolveAccountId(): string {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID
  const json = execSync('npx wrangler whoami --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const payload = JSON.parse(json) as { accounts?: Array<{ id?: string }> }
  const accountId = payload.accounts?.[0]?.id
  if (!accountId) {
    throw new Error('Could not resolve Cloudflare account id. Set CLOUDFLARE_ACCOUNT_ID.')
  }
  return accountId
}

function resolveApiToken(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN
  const output = execSync('npx wrangler auth token 2>/dev/null', { encoding: 'utf8' })
  const candidates = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 20 && /^[\x21-\x7E]+$/.test(line))
  const token = candidates.at(-1)
  if (!token) {
    throw new Error('No Cloudflare API token. Run `wrangler login` or set CLOUDFLARE_API_TOKEN.')
  }
  return token
}

function createWorkersAiBinding(accountId: string, token: string): WorkersAiBinding {
  return {
    async run(model, input) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      })
      const payload = await response.json() as {
        success?: boolean
        result?: unknown
        errors?: Array<{ message?: string }>
      }
      if (!response.ok || payload.success === false) {
        const message = payload.errors?.map((error) => error.message).join('; ')
          || `Workers AI request failed (${response.status})`
        throw new Error(message)
      }
      return payload.result
    },
  }
}

function createVectorizeBinding(accountId: string, token: string): VectorizeBinding {
  return {
    async query(vector, options) {
      const url =
        `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
        `/vectorize/v2/indexes/${VECTORIZE_INDEX_NAME}/query`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vector,
          topK: options?.topK,
          returnMetadata: options?.returnMetadata ?? 'all',
        }),
      })
      const payload = await response.json() as {
        success?: boolean
        result?: { matches?: unknown[] }
        errors?: Array<{ message?: string }>
      }
      if (!response.ok || payload.success === false) {
        const message = payload.errors?.map((error) => error.message).join('; ')
          || `Vectorize query failed (${response.status})`
        throw new Error(message)
      }
      return { matches: payload.result?.matches ?? [] }
    },
  }
}

function preview(answer: string, maxChars = 120): string {
  const oneLine = answer.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxChars) return oneLine
  return `${oneLine.slice(0, maxChars)}…`
}

async function retrieveThinSources(
  ai: WorkersAiBinding,
  vectorize: VectorizeBinding,
  question: string,
  topK: number,
): Promise<{ sources: CagSource[]; retrievalMs: number }> {
  const started = performance.now()
  const sources = await retrieveCagSourcesFromVectorize(
    ai,
    vectorize,
    question,
    { topK, minScore: DEFAULT_VECTORIZE_MIN_COSINE_SCORE },
  )
  return { sources, retrievalMs: performance.now() - started }
}

async function evalCaseArm(
  ai: WorkersAiBinding,
  vectorize: VectorizeBinding,
  testCase: CagEvalCase,
  arm: EvalArm,
  archiveBaseUrl: string,
  topK: number,
  generateOptions: EvalGenerateOptions,
): Promise<CaseArmResult | null> {
  const { sources: thinSources, retrievalMs } = await retrieveThinSources(
    ai,
    vectorize,
    testCase.question,
    topK,
  )
  if (thinSources.length === 0) {
    console.warn(`[skip] ${testCase.id}/${arm}: no vectorize sources`)
    return null
  }

  let sources = thinSources
  let hydrateMs = 0
  if (arm === 'hydrate') {
    const hydrateStarted = performance.now()
    sources = await hydrateCagSourcesFromArchive(archiveBaseUrl, thinSources)
    hydrateMs = performance.now() - hydrateStarted
    if (sources.length === 0) {
      console.warn(`[skip] ${testCase.id}/${arm}: hydrate produced no sources`)
      return null
    }
  }

  const generateStarted = performance.now()
  const answerLanguage = generateOptions.profile === 'audrey'
    ? detectCagAnswerLanguage(testCase.question)
    : undefined
  const answerInstruction = generateOptions.profile === 'audrey'
    ? buildAudreySkillAnswerInstruction(answerLanguage)
    : undefined
  const messages = buildCagMessages(
    testCase.question,
    sources,
    [],
    answerInstruction,
    answerLanguage,
  )
  const answer = await completeCagAnswer(ai, messages as ChatMessage[], {
    model: generateOptions.model,
    maxCompletionTokens: 1024,
  })
  const generateMs = performance.now() - generateStarted

  const binary = scoreCagAnswer(answer, sources.length, {
    requireTraditionalChinese: testCase.requireTraditionalChinese,
    minCitations: testCase.minCitations,
  })
  const depth = scoreCagDepth(answer, sources, binary.citedIndexes, {
    binaryPassed: binary.passed,
    minAnswerChars: testCase.minAnswerChars,
    minGroundingScore: testCase.minGroundingScore,
  })

  return {
    arm,
    caseId: testCase.id,
    sourceCount: sources.length,
    passed: binary.passed,
    shallow: depth.shallow,
    answerChars: depth.answerChars,
    groundingScore: depth.groundingScore,
    totalSourceChars: depth.totalSourceChars,
    retrievalMs,
    hydrateMs,
    generateMs,
    answerPreview: preview(answer),
    answerFull: answer.trim(),
  }
}

function printCaseComparison(result: CompareCaseResult, fullAnswers: boolean) {
  console.log(`\n${result.caseId}`)
  for (const arm of ['thin', 'hydrate'] as const) {
    const row = result[arm]
    if (!row) {
      console.log(`  ${arm}: [skipped]`)
      continue
    }
    const passMark = row.passed ? 'PASS' : 'FAIL'
    const shallowMark = row.shallow ? 'shallow' : 'deep'
    console.log(
      `  ${arm}: ${passMark} ${shallowMark} ` +
      `ans=${row.answerChars}ch grounding=${row.groundingScore.toFixed(2)} ` +
      `sources=${row.totalSourceChars}ch ` +
      `t=${(row.retrievalMs + row.hydrateMs + row.generateMs).toFixed(0)}ms ` +
      `(r${row.retrievalMs.toFixed(0)}+h${row.hydrateMs.toFixed(0)}+g${row.generateMs.toFixed(0)})`,
    )
    const text = fullAnswers ? row.answerFull ?? row.answerPreview : row.answerPreview
    if (fullAnswers) {
      console.log(`  --- ${arm} answer ---`)
      console.log(text)
      console.log(`  --- end ${arm} ---`)
    } else {
      console.log(`        ${text}`)
    }
  }
  if (result.thin && result.hydrate) {
    const deltaChars = result.hydrate.answerChars - result.thin.answerChars
    const deltaSources = result.hydrate.totalSourceChars - result.thin.totalSourceChars
    const deltaGrounding = result.hydrate.groundingScore - result.thin.groundingScore
    const thinMs = result.thin.retrievalMs + result.thin.generateMs
    const hydrateMs = result.hydrate.retrievalMs + result.hydrate.hydrateMs + result.hydrate.generateMs
    console.log(
      `  Δ ans ${deltaChars >= 0 ? '+' : ''}${deltaChars}ch, ` +
      `sources ${deltaSources >= 0 ? '+' : ''}${deltaSources}ch, ` +
      `grounding ${deltaGrounding >= 0 ? '+' : ''}${deltaGrounding.toFixed(2)}, ` +
      `latency ${(hydrateMs - thinMs).toFixed(0)}ms`,
    )
  }
}

function summarizeArm(results: CaseArmResult[]) {
  const passed = results.filter((result) => result.passed).length
  const shallow = results.filter((result) => result.shallow).length
  const avgLatency = results.reduce(
    (sum, result) => sum + result.retrievalMs + result.hydrateMs + result.generateMs,
    0,
  ) / Math.max(results.length, 1)
  return { passed, shallow, total: results.length, avgLatency }
}

function printSummary(comparisons: CompareCaseResult[]) {
  const thinRows = comparisons.map((row) => row.thin).filter((row): row is CaseArmResult => row !== null)
  const hydrateRows = comparisons.map((row) => row.hydrate).filter((row): row is CaseArmResult => row !== null)

  console.log('\nSummary')
  console.log('=======')
  if (thinRows.length > 0) {
    const thin = summarizeArm(thinRows)
    console.log(
      `thin:     pass ${thin.passed}/${thin.total}, shallow ${thin.shallow}/${thin.total}, ` +
      `avg latency ${thin.avgLatency.toFixed(0)}ms`,
    )
  }
  if (hydrateRows.length > 0) {
    const hydrate = summarizeArm(hydrateRows)
    console.log(
      `hydrate:  pass ${hydrate.passed}/${hydrate.total}, shallow ${hydrate.shallow}/${hydrate.total}, ` +
      `avg latency ${hydrate.avgLatency.toFixed(0)}ms`,
    )
  }
  if (thinRows.length > 0 && hydrateRows.length > 0) {
    const shallowDelta = summarizeArm(hydrateRows).shallow - summarizeArm(thinRows).shallow
    console.log(`shallow delta (hydrate - thin): ${shallowDelta >= 0 ? '+' : ''}${shallowDelta}`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const fullAnswers = parseFullAnswers(argv)
  const mode = parseMode(argv)
  const filter = parseCaseFilter(argv)
  const profile = parseProfile(argv)
  const model = parseModel(argv, profile)
  const baseCases = profile === 'audrey' ? DEFAULT_AUDREY_EVAL_CASES : DEFAULT_CAG_EVAL_CASES
  const cases = filter
    ? baseCases.filter((testCase) => filter.includes(testCase.id))
    : baseCases
  if (cases.length === 0) throw new Error('No eval cases selected.')

  const archiveBaseUrl = process.env.ASK_ARCHIVE_BASE_URL ?? 'https://archive.tw'
  const topK = Number(process.env.CAG_EVAL_TOP_K ?? DEFAULT_TOP_K)
  const accountId = resolveAccountId()
  const token = resolveApiToken()
  const ai = createWorkersAiBinding(accountId, token)
  const vectorize = createVectorizeBinding(accountId, token)

  console.log(
    `${profile === 'audrey' ? 'Audrey' : 'CAG'} depth eval (${mode}) — ` +
    `model=${model}, topK=${topK}, index=${VECTORIZE_INDEX_NAME}`,
  )

  const generateOptions: EvalGenerateOptions = { profile, model }

  const comparisons: CompareCaseResult[] = []
  for (const testCase of cases) {
    console.log(`\n→ ${testCase.id}`)
    if (mode === 'compare') {
      const thin = await evalCaseArm(ai, vectorize, testCase, 'thin', archiveBaseUrl, topK, generateOptions)
      const hydrate = await evalCaseArm(ai, vectorize, testCase, 'hydrate', archiveBaseUrl, topK, generateOptions)
      const comparison = { caseId: testCase.id, thin, hydrate }
      comparisons.push(comparison)
      printCaseComparison(comparison, fullAnswers)
      continue
    }

    const result = await evalCaseArm(ai, vectorize, testCase, mode, archiveBaseUrl, topK, generateOptions)
    if (result) {
      const comparison = {
        caseId: testCase.id,
        thin: mode === 'thin' ? result : null,
        hydrate: mode === 'hydrate' ? result : null,
      }
      comparisons.push(comparison)
      printCaseComparison(comparison, fullAnswers)
    }
  }

  if (comparisons.every((row) => row.thin === null && row.hydrate === null)) {
    throw new Error('No eval cases produced vectorize sources.')
  }

  printSummary(comparisons)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})