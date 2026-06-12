import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ARCHIVE_TW_URL,
  NOT_FOUND_REPLY_HTML,
  NOT_FOUND_REPLY_PLAIN,
} from '../src/utils/notFoundReply'

test('NOT_FOUND_REPLY_PLAIN keeps archive.tw URL for LINE and plain text', () => {
  assert.match(NOT_FOUND_REPLY_PLAIN, /https:\/\/archive\.tw/)
  assert.doesNotMatch(NOT_FOUND_REPLY_PLAIN, /<a\b/i)
})

test('NOT_FOUND_REPLY_HTML is static markup without executable content', () => {
  assert.match(
    NOT_FOUND_REPLY_HTML,
    /<a href="https:\/\/archive\.tw" rel="nofollow noreferrer noopener" target="_blank">https:\/\/archive\.tw<\/a>/,
  )
  assert.equal(ARCHIVE_TW_URL, 'https://archive.tw')
  assert.doesNotMatch(NOT_FOUND_REPLY_HTML, /<script\b/i)
  assert.doesNotMatch(NOT_FOUND_REPLY_HTML, /\bon\w+\s*=/i)
  assert.doesNotMatch(NOT_FOUND_REPLY_HTML, /javascript:/i)
})