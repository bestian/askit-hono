/**
 * Smoke-test Nemotron Ultra over the CF AI Gateway `baseten` provider.
 *
 * Loads `.dev.vars` automatically. Requires CF_AIG_TOKEN (same value as the
 * production worker secret). The Baseten credential is a provider key stored on
 * the Cloudflare side, so no Baseten token is read or sent from here.
 *
 * Usage:
 *   npm run cf:baseten-verify
 */

import { completeViaGatewayChatCompletions } from '../src/baseten'
import { loadDevVars } from '../src/loadDevVars'
import { resolveAudreyAiGateway } from '../src/resolveGateway'

loadDevVars()

async function smokeCfGateway(): Promise<string> {
  const gateway = resolveAudreyAiGateway({
    AUDREY_MODEL: process.env.AUDREY_MODEL ?? 'nemotron-ultra',
    BASETEN_MODEL: process.env.BASETEN_MODEL,
    CF_AIG_TOKEN: process.env.CF_AIG_TOKEN,
    CF_AI_GATEWAY_ACCOUNT_ID: process.env.CF_AI_GATEWAY_ACCOUNT_ID,
    CF_AI_GATEWAY_ID: process.env.CF_AI_GATEWAY_ID,
  })
  if (!gateway || gateway.kind !== 'chat') {
    throw new Error('Gateway config missing (AUDREY_MODEL / CF_AIG_TOKEN?)')
  }
  if (gateway.config.upstreamAuthorization) {
    throw new Error(
      'Upstream Authorization header set; it would override the provider key stored on Cloudflare',
    )
  }
  console.log('model:', gateway.config.chatModel)
  console.log('url:', gateway.config.chatCompletionsUrl)
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
  if (!process.env.CF_AIG_TOKEN?.trim()) {
    console.error(
      'cf_gateway: CF_AIG_TOKEN missing — set it in .dev.vars (AI Gateway Run token from the dashboard)',
    )
    process.exitCode = 1
    return
  }

  const viaCf = await smokeCfGateway()
  console.log('cf_gateway: ok')
  console.log('cf_visible:', JSON.stringify(viaCf.slice(0, 200)))
}

main().catch((err) => {
  console.error('cf_gateway: failed')
  console.error(err)
  process.exit(1)
})
