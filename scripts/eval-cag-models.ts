/**
 * CAG quality eval for the fixed Gemma 4 26B A4B model.
 *
 * Usage (from repo root):
 *   npm run eval:cag
 *   npm run eval:cag -- --cases=earth-god-incense,digital-signature
 *
 * Auth: CLOUDFLARE_API_TOKEN, or `wrangler auth token` when logged in.
 * Account: CLOUDFLARE_ACCOUNT_ID (defaults to wrangler whoami JSON).
 */
import { execSync } from 'node:child_process'

import {
  buildCagMessages,
  completeCagAnswer,
  retrieveCagSources,
} from '../src/utils/cag'
import {
  CAG_EVAL_PASS_RATIO,
  DEFAULT_CAG_EVAL_CASES,
  evalMeetsThreshold,
  scoreCagAnswer,
  type CagEvalCase,
} from '../src/utils/cagEval'

type ChatMessage = {
  role: 'system' | 'user'
  content: string
}

type WorkersAiBinding = {
  run: (model: string, input: Record<string, unknown>) => Promise<unknown>
}

type CaseResult = {
  caseId: string
  sourceCount: number
  passed: boolean
  answerPreview: string
}

function parseCaseFilter(argv: string[]): string[] | null {
  const flag = argv.find((arg) => arg.startsWith('--cases='))
  if (!flag) return null
  return flag.slice('--cases='.length).split(',').map((id) => id.trim()).filter(Boolean)
}

function resolveAccountId(): string {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID
  const json = execSync('npx wrangler whoami --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const payload = JSON.parse(json) as {
    accounts?: Array<{ id?: string }>
  }
  const accountId = payload.accounts?.[0]?.id
  if (!accountId) {
    throw new Error('Could not resolve Cloudflare account id. Set CLOUDFLARE_ACCOUNT_ID.')
  }
  return accountId
}

function resolveApiToken(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN
  const output = execSync('npx wrangler auth token 2>/dev/null', {
    encoding: 'utf8',
  })
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

function preview(answer: string, maxChars = 120): string {
  const oneLine = answer.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxChars) return oneLine
  return `${oneLine.slice(0, maxChars)}…`
}

async function evalCase(
  ai: WorkersAiBinding,
  testCase: CagEvalCase,
  archiveBaseUrl: string,
): Promise<CaseResult | null> {
  const sources = await retrieveCagSources(testCase.question, {
    archiveBaseUrl,
    topK: 6,
  })
  if (sources.length === 0) {
    console.warn(`[skip] ${testCase.id}: no sources retrieved`)
    return null
  }

  const messages = buildCagMessages(testCase.question, sources)
  const answer = await completeCagAnswer(ai, messages as ChatMessage[])
  const score = scoreCagAnswer(answer, sources.length, {
    requireTraditionalChinese: testCase.requireTraditionalChinese,
    minCitations: testCase.minCitations,
  })

  return {
    caseId: testCase.id,
    sourceCount: sources.length,
    passed: score.passed,
    answerPreview: preview(answer),
  }
}

function printReport(results: CaseResult[]) {
  console.log('\nCAG eval report (Gemma 4 26B A4B)')
  console.log('==================================')
  for (const result of results) {
    const mark = result.passed ? 'PASS' : 'FAIL'
    console.log(`\n${result.caseId} (${result.sourceCount} sources)`)
    console.log(`  ${mark} — ${result.answerPreview}`)
  }

  const passed = results.filter((result) => result.passed).length
  const total = results.length
  const ratio = total > 0 ? passed / total : 0

  console.log('\nSummary')
  console.log(`  passed: ${passed}/${total} (${(ratio * 100).toFixed(1)}%)`)
  console.log(`  pass threshold: ${(CAG_EVAL_PASS_RATIO * 100).toFixed(0)}%`)

  if (!evalMeetsThreshold(passed, total)) {
    throw new Error(`CAG eval below threshold (${passed}/${total}).`)
  }
  console.log('\nGemma meets eval threshold.')
}

async function main() {
  const filter = parseCaseFilter(process.argv.slice(2))
  const cases = filter
    ? DEFAULT_CAG_EVAL_CASES.filter((testCase) => filter.includes(testCase.id))
    : DEFAULT_CAG_EVAL_CASES

  if (cases.length === 0) {
    throw new Error('No eval cases selected.')
  }

  const archiveBaseUrl = process.env.ASK_ARCHIVE_BASE_URL ?? 'https://archive.tw'
  const accountId = resolveAccountId()
  const token = resolveApiToken()
  const ai = createWorkersAiBinding(accountId, token)

  console.log(`Evaluating ${cases.length} case(s) against archive.tw + Workers AI…`)

  const results: CaseResult[] = []
  for (const testCase of cases) {
    console.log(`\n→ ${testCase.id}`)
    const result = await evalCase(ai, testCase, archiveBaseUrl)
    if (result) results.push(result)
  }

  if (results.length === 0) {
    throw new Error('No eval cases produced sources. Check archive.tw connectivity.')
  }

  printReport(results)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})