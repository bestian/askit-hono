import assert from 'node:assert/strict'
import test from 'node:test'

import { createAskCors } from '../src/askCors'

const ALLOWED = 'https://archive.tw'
const DENIED = 'https://evil.example'

const askCors = createAskCors({
  allowedOrigins: new Set([
    'https://archive.tw',
    'https://ask.archive.tw',
    'http://localhost:8787',
  ]),
})

test('isAllowedOrigin accepts listed origins', () => {
  assert.equal(askCors.isAllowedOrigin(ALLOWED), true)
  assert.equal(askCors.isAllowedOrigin('https://ask.archive.tw'), true)
  assert.equal(askCors.isAllowedOrigin('http://localhost:8787'), true)
})

test('isAllowedOrigin rejects unlisted origins', () => {
  assert.equal(askCors.isAllowedOrigin(DENIED), false)
  assert.equal(askCors.isAllowedOrigin(undefined), false)
})

test('apply adds CORS headers for allowed origin', () => {
  const request = new Request('https://example.test/au/hello', {
    headers: { Origin: ALLOWED },
  })
  const response = askCors.apply(request, new Response('ok', { status: 200 }))
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED)
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS')
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type')
  assert.equal(response.headers.get('Access-Control-Max-Age'), '600')
  assert.match(response.headers.get('Vary') ?? '', /Origin/i)
})

test('apply adds Vary: Origin but no CORS for denied origin', () => {
  const request = new Request('https://example.test/au/hello', {
    headers: { Origin: DENIED },
  })
  const inner = new Response('ok', { status: 200, headers: { 'X-Test': '1' } })
  const response = askCors.apply(request, inner)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
  assert.equal(response.headers.get('X-Test'), '1')
  assert.match(response.headers.get('Vary') ?? '', /Origin/i)
})

test('apply adds Vary: Origin for missing origin', () => {
  const request = new Request('https://example.test/au/hello')
  const inner = new Response('ok', { status: 200 })
  const response = askCors.apply(request, inner)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
  assert.match(response.headers.get('Vary') ?? '', /Origin/i)
})

test('preflight returns 204 with CORS for allowed origin', () => {
  const request = new Request('https://example.test/au/hello', {
    method: 'OPTIONS',
    headers: { Origin: ALLOWED },
  })
  const response = askCors.preflight(request)
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED)
})