import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorkersAiChatInput,
  resolveWorkersAiChatModel,
  streamViaWorkersAiChat,
  type WorkersAiBinding,
} from '../src/workersAi'

// Gateway aliases must NOT resolve here, or they would bypass the gateway
// precedence in each consumer and silently change provider.
test('resolveWorkersAiChatModel only claims @cf/ ids', () => {
  assert.equal(
    resolveWorkersAiChatModel('@cf/deepseek-ai/deepseek-v4-flash-0731'),
    '@cf/deepseek-ai/deepseek-v4-flash-0731',
  )
  assert.equal(resolveWorkersAiChatModel('  @cf/google/gemma-4-26b-a4b-it  '), '@cf/google/gemma-4-26b-a4b-it')
  assert.equal(resolveWorkersAiChatModel('nemotron-ultra'), undefined)
  assert.equal(resolveWorkersAiChatModel('fugu'), undefined)
  assert.equal(resolveWorkersAiChatModel(''), undefined)
  assert.equal(resolveWorkersAiChatModel(undefined), undefined)
})

test('buildWorkersAiChatInput clamps tokens and disables reasoning', () => {
  const input = buildWorkersAiChatInput(
    [{ role: 'user', content: 'hi' }],
    99_999,
    true,
  )
  assert.equal(input.stream, true)
  assert.equal(input.max_completion_tokens, 8_192)
  assert.equal(input.temperature, 0.2)
  assert.equal(input.reasoning_effort, 'none')
  assert.deepEqual(input.chat_template_kwargs, {
    thinking: false,
    enable_thinking: false,
  })

  const floored = buildWorkersAiChatInput([], 0, false)
  assert.equal(floored.max_completion_tokens, 1)
  assert.equal(floored.stream, false)
})

test('streamViaWorkersAiChat returns the binding stream and forwards the model', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
  const calls: Array<{ model: string; input: Record<string, unknown> }> = []
  const ai: WorkersAiBinding = {
    async run(model, input) {
      calls.push({ model, input })
      return body
    },
  }
  const stream = await streamViaWorkersAiChat(
    ai,
    '@cf/deepseek-ai/deepseek-v4-flash-0731',
    [{ role: 'user', content: 'hi' }],
    256,
  )
  assert.equal(stream, body)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, '@cf/deepseek-ai/deepseek-v4-flash-0731')
  assert.equal(calls[0].input.stream, true)
  assert.equal(calls[0].input.max_completion_tokens, 256)
})

// A non-stream result must fail loudly; consumers catch and fall back to
// retrieval excerpts, so a silent empty answer would look like a real one.
test('streamViaWorkersAiChat throws when the binding does not stream', async () => {
  const ai: WorkersAiBinding = {
    async run() {
      return { response: 'not a stream' }
    },
  }
  await assert.rejects(
    () => streamViaWorkersAiChat(ai, '@cf/some/model', [], 64),
    /did not return a stream/,
  )
})
