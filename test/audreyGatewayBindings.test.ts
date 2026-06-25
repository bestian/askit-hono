import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAudreyAiGateway } from '../src/utils/audreyGatewayBindings'
import { DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL } from '../src/utils/basetenGateway'

test('resolveAudreyAiGateway returns Baseten chat config for nemotron-ultra', () => {
  const gw = resolveAudreyAiGateway({
    AUDREY_MODEL: 'nemotron-ultra',
    BASETEN_API_KEY: 'test-key',
    CF_AI_GATEWAY_ACCOUNT_ID: 'acct',
    CF_AI_GATEWAY_ID: 'gw',
  })
  assert.ok(gw)
  assert.equal(gw.kind, 'chat')
  if (gw.kind !== 'chat') return
  assert.match(gw.config.chatCompletionsUrl, /\/baseten\/v1\/chat\/completions$/)
  assert.equal(gw.config.upstreamAuthorization, 'Api-Key test-key')
  assert.equal(gw.config.chatModel, DEFAULT_NEMOTRON_ULTRA_BASETEN_MODEL)
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