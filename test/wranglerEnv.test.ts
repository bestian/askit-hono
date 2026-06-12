import assert from 'node:assert/strict'
import test from 'node:test'

import { buildWranglerEnv } from '../scripts/wranglerEnv'

const baseEnv: NodeJS.ProcessEnv = {
  CLOUDFLARE_API_TOKEN: 'cf-token',
  CLOUDFLARE_ACCOUNT_ID: 'acct-123',
  PATH: '/usr/bin',
}

test('buildWranglerEnv strips API token locally (OAuth-first)', () => {
  const env = buildWranglerEnv(baseEnv)
  assert.equal(env.CLOUDFLARE_API_TOKEN, undefined)
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'acct-123')
})

test('buildWranglerEnv keeps API token in GitHub Actions', () => {
  const env = buildWranglerEnv({ ...baseEnv, GITHUB_ACTIONS: 'true' })
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'cf-token')
})

test('buildWranglerEnv keeps API token when CI=true', () => {
  const env = buildWranglerEnv({ ...baseEnv, CI: 'true' })
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'cf-token')
})

test('buildWranglerEnv keeps API token when WRANGLER_USE_API_TOKEN=1', () => {
  const env = buildWranglerEnv({ ...baseEnv, WRANGLER_USE_API_TOKEN: '1' })
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'cf-token')
})

test('buildWranglerEnv does not mutate the source env', () => {
  const source = { ...baseEnv }
  buildWranglerEnv(source)
  assert.equal(source.CLOUDFLARE_API_TOKEN, 'cf-token')
})