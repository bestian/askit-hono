import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL } from '../src/baseten'
import { resolveAudreyAiGateway } from '../src/resolveGateway'

test('resolveAudreyAiGateway returns Baseten chat config for nemotron-ultra', () => {
  const gw = resolveAudreyAiGateway({
    AUDREY_MODEL: 'nemotron-ultra',
    CF_AIG_TOKEN: 'cf-run-token',
    CF_AI_GATEWAY_ACCOUNT_ID: 'acct',
    CF_AI_GATEWAY_ID: 'gw',
  })
  assert.ok(gw)
  assert.equal(gw.kind, 'chat')
  if (gw.kind !== 'chat') return
  assert.match(gw.config.chatCompletionsUrl, /\/baseten\/v1\/chat\/completions$/)
  assert.equal(gw.config.gatewayAuthToken, 'cf-run-token')
  assert.equal(gw.config.chatModel, DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL)
})

// The Baseten key lives on the Cloudflare side; forwarding an upstream
// Authorization header would override that stored key.
test('resolveAudreyAiGateway omits upstream auth for nemotron-ultra', () => {
  const gw = resolveAudreyAiGateway({
    AUDREY_MODEL: 'nemotron-ultra',
    CF_AIG_TOKEN: 'cf-run-token',
  })
  assert.ok(gw)
  if (gw.kind !== 'chat') return
  assert.equal(gw.config.upstreamAuthorization, undefined)
})

// Authenticated gateway: without a run token every request 401s, so /au must
// stay on the Workers AI path instead.
test('resolveAudreyAiGateway returns undefined for nemotron-ultra without CF_AIG_TOKEN', () => {
  const gw = resolveAudreyAiGateway({ AUDREY_MODEL: 'nemotron-ultra' })
  assert.equal(gw, undefined)
})

test('resolveAudreyAiGateway returns Sakana responses for fugu', () => {
  const gw = resolveAudreyAiGateway({
    AUDREY_MODEL: 'fugu',
    SAKANA_API_KEY: 'sk',
  })
  assert.ok(gw)
  assert.equal(gw.kind, 'responses')
  if (gw.kind !== 'responses') return
  assert.match(gw.config.responsesUrl, /custom-sakana\/v1\/responses$/)
})

test('resolveAudreyAiGateway returns undefined when AUDREY_MODEL unset (even with CF_AIG_TOKEN)', () => {
  const gw = resolveAudreyAiGateway({
    CF_AIG_TOKEN: 'cf',
  })
  assert.equal(gw, undefined)
})

test('resolveAudreyAiGateway returns undefined for gemma/glm (Workers AI path)', () => {
  for (const audreyModel of [undefined, '', '@cf/google/gemma-4-26b-a4b-it', '@cf/zai-org/glm-5.2']) {
    const gw = resolveAudreyAiGateway({
      AUDREY_MODEL: audreyModel,
      CF_AIG_TOKEN: 'cf',
      SAKANA_API_KEY: 'sk',
    })
    assert.equal(gw, undefined, `expected undefined for AUDREY_MODEL=${String(audreyModel)}`)
  }
})