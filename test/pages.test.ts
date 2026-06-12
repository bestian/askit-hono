import assert from 'node:assert/strict'
import test from 'node:test'

import app from '../src/index'

test('GET /en serves the English home page', async () => {
  const response = await app.request('/en')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="en">/)
  assert.match(html, /Ask Audrey/)
  assert.match(html, /property="og:locale" content="en_US"/)
  assert.match(html, /rel="canonical" href="https:\/\/ask\.archive\.tw\/en"/)
  assert.match(html, /hreflang="zh-Hant" href="https:\/\/ask\.archive\.tw\/"/)
  assert.match(html, /hreflang="en" href="https:\/\/ask\.archive\.tw\/en"/)
  assert.match(html, /href="\/en\/privacy"/)
  assert.match(html, /href="\/en\/terms"/)
  assert.match(html, /href="\/">華語<\/a>/)
})

test('GET / stays zh-Hant and gains only the toggle and hreflang links', async () => {
  const response = await app.request('/')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="zh-Hant">/)
  assert.match(html, /<title>鳳問 \| 認識唐鳳的思想<\/title>/)
  assert.match(html, /property="og:locale" content="zh_TW"/)
  assert.match(
    html,
    /property="og:description" content="提出問題，AI 會檢索唐鳳的逐字稿並附上出處作答，帶你認識唐鳳的思想。"/,
  )
  assert.match(html, /hreflang="en" href="https:\/\/ask\.archive\.tw\/en"/)
  assert.match(html, /href="\/en">English<\/a>/)
  assert.match(html, /href="\/privacy">隱私權政策<\/a>/)
  assert.match(html, /<script src="\/app\.js" defer><\/script>/)
})

test('GET /en/privacy serves English-first privacy page', async () => {
  const response = await app.request('/en/privacy')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="en">/)
  assert.match(html, /rel="canonical" href="https:\/\/ask\.archive\.tw\/en\/privacy"/)
  assert.match(html, /hreflang="zh-Hant" href="https:\/\/ask\.archive\.tw\/privacy"/)
  assert.match(html, /the Chinese version governs/)
  // English section appears before the zh section
  assert.ok(html.indexOf('id="privacy-en"') < html.indexOf('id="privacy-zh"'))
})

test('GET /privacy stays zh-first with hreflang added', async () => {
  const response = await app.request('/privacy')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="zh-Hant">/)
  assert.match(html, /hreflang="en" href="https:\/\/ask\.archive\.tw\/en\/privacy"/)
  assert.ok(html.indexOf('id="privacy-zh"') < html.indexOf('id="privacy-en"'))
})

test('GET /en/terms serves English-first terms page', async () => {
  const response = await app.request('/en/terms')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="en">/)
  assert.match(html, /the Chinese version governs/)
  assert.match(html, /CC BY-SA/)
  assert.ok(html.indexOf('id="terms-en"') < html.indexOf('id="terms-zh"'))
})

test('GET /terms stays zh-first', async () => {
  const response = await app.request('/terms')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /<html lang="zh-Hant">/)
  assert.ok(html.indexOf('id="terms-zh"') < html.indexOf('id="terms-en"'))
})
