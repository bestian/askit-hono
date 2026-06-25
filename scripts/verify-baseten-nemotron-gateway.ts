/**
 * Smoke-test Baseten Nemotron (direct API + optional CF AI Gateway /au path).
 *
 * Loads `.dev.vars` automatically. Requires BASETEN_API_KEY.
 * CF gateway path also needs CF_AIG_TOKEN (same as production worker secret).
 *
 * Usage:
 *   npm run cf:baseten-verify
 */

import { loadDevVars } from './loadDevVars'
import { resolveAudreyAiGateway } from '../src/utils/audreyGatewayBindings'
import { completeViaGatewayChatCompletions } from '../src/utils/basetenGateway'

loadDevVars()

const DEFAULT_MODEL = 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B'

async function smokeDirectBaseten(): Promise<string> {
  const key = process.env.BASETEN_API_KEY?.trim()
  const model = process.env.BASETEN_MODEL?.trim() || DEFAULT_MODEL
  if (!key) throw new Error('BASETEN_API_KEY missing')
  const res = await fetch('https://inference.baseten.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'user', content: 'Reply with exactly NEMOTRON_DIRECT_OK.' },
      ],
      max_tokens: 64,
      stream: false,
    }),
  })
  if (!res.ok) {
    throw new Error(
      `Direct Baseten HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`,
    )
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return json.choices?.[0]?.message?.content?.trim() ?? ''
}

async function smokeCfGateway(): Promise<string> {
  const gateway = resolveAudreyAiGateway({
    AUDREY_MODEL: process.env.AUDREY_MODEL ?? 'nemotron-ultra',
    BASETEN_API_KEY: process.env.BASETEN_API_KEY,
    BASETEN_MODEL: process.env.BASETEN_MODEL,
    CF_AIG_TOKEN: process.env.CF_AIG_TOKEN,
    CF_AI_GATEWAY_ACCOUNT_ID: process.env.CF_AI_GATEWAY_ACCOUNT_ID,
    CF_AI_GATEWAY_ID: process.env.CF_AI_GATEWAY_ID,
  })
  if (!gateway || gateway.kind !== 'chat') {
    throw new Error('Gateway config missing (BASETEN_API_KEY?)')
  }
  const res = await completeViaGatewayChatCompletions(
    gateway.config,
    [{ role: 'user', content: 'Reply with exactly NEMOTRON_CF_OK.' }],
    256,
    false,
  )
  const json = (await res.json()) as { response?: string }
  return json.response ?? ''
}

async function main(): Promise<void> {
  const direct = await smokeDirectBaseten()
  console.log('direct_baseten: ok')
  console.log('direct_visible:', JSON.stringify(direct.slice(0, 200)))

  if (!process.env.CF_AIG_TOKEN?.trim()) {
    console.log(
      'cf_gateway: skipped (set CF_AIG_TOKEN in .dev.vars — copy from wrangler secret put CF_AIG_TOKEN / dashboard AI Gateway Run token)',
    )
    return
  }

  try {
    const viaCf = await smokeCfGateway()
    console.log('cf_gateway: ok')
    console.log('cf_visible:', JSON.stringify(viaCf.slice(0, 200)))
  } catch (err) {
    console.log('cf_gateway: failed')
    console.error(err)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})