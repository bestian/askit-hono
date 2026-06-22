import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCustomSakanaResponsesUrl,
  messagesToResponsesInput,
  openAiResponsesEventStreamToText,
} from '../src/utils/fuguGateway'

test('buildCustomSakanaResponsesUrl uses kami custom-sakana path', () => {
  const url = buildCustomSakanaResponsesUrl(
    '99984e3c707dd2518f73dfa9da3fc887',
    'kami',
  )
  assert.equal(
    url,
    'https://gateway.ai.cloudflare.com/v1/99984e3c707dd2518f73dfa9da3fc887/kami/custom-sakana/v1/responses',
  )
})

test('messagesToResponsesInput flattens chat roles', () => {
  const input = messagesToResponsesInput([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
  ])
  assert.match(input, /System:\nsys/)
  assert.match(input, /User:\nq/)
})

test('openAiResponsesEventStreamToText extracts output_text delta', async () => {
  const sse = new TextEncoder().encode(
    'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
  )
  const reader = new Response(sse)
    .body!.pipeThrough(openAiResponsesEventStreamToText())
    .getReader()
  const chunk = await reader.read()
  assert.equal(chunk.value, 'hello')
})
test('openAiResponsesEventStreamToText does not triple on delta then done events', async () => {
  const sse = new TextEncoder().encode(
    [
      'data: {"type":"response.output_text.delta","delta":"hel"}',
      'data: {"type":"response.output_text.delta","delta":"lo"}',
      'data: {"type":"response.output_text.done","text":"hello"}',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"hello"}]}}',
    ].join('\n\n') + '\n\n',
  )
  const reader = new Response(sse)
    .body!.pipeThrough(openAiResponsesEventStreamToText())
    .getReader()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += value
  }
  assert.equal(out, 'hello')
})

test('openAiResponsesEventStreamToText uses done fallback when no deltas', async () => {
  const sse = new TextEncoder().encode(
    'data: {"type":"response.output_text.done","text":"only-done"}\n\n',
  )
  const reader = new Response(sse)
    .body!.pipeThrough(openAiResponsesEventStreamToText())
    .getReader()
  const chunk = await reader.read()
  assert.equal(chunk.value, 'only-done')
})

test('openAiResponsesEventStreamToText ignores reasoning_summary_text.delta', async () => {
  const sse = new TextEncoder().encode(
    'data: {"type":"response.reasoning_summary_text.delta","delta":"**Reframing responses**"}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"答案"}\n\n',
  )
  const reader = new Response(sse)
    .body!.pipeThrough(openAiResponsesEventStreamToText())
    .getReader()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += value
  }
  assert.equal(out, '答案')
})
