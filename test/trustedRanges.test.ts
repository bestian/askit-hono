import assert from 'node:assert/strict'
import test from 'node:test'

import { isBlacklistExemptIp } from '../src/utils/trustedRanges'

test('Cloudflare WARP 出口（issue #50 實際肇因）落在完整 /12 內，豁免', () => {
  // 104.28.198.3 在 Cloudflare 對外 announce 的 104.16.0.0/12，但「不在」官方
  // CDN ingress 清單（104.16/13 + 104.24/14 只到 104.27.x）。必須被豁免。
  assert.equal(isBlacklistExemptIp('104.28.198.3'), true)
  assert.equal(isBlacklistExemptIp('104.28.198.10'), true)
})

test('Cloudflare 公布的 CDN 邊緣網段也豁免', () => {
  assert.equal(isBlacklistExemptIp('162.158.0.1'), true) // 162.158.0.0/15
  assert.equal(isBlacklistExemptIp('172.64.0.1'), true) // 172.64.0.0/13
  assert.equal(isBlacklistExemptIp('131.0.72.1'), true) // 131.0.72.0/22
})

test('Cloudflare IPv6 網段豁免（含大小寫與 :: 壓縮）', () => {
  assert.equal(isBlacklistExemptIp('2606:4700::1'), true)
  assert.equal(isBlacklistExemptIp('2400:CB00:0:0:0:0:0:1'), true)
  assert.equal(isBlacklistExemptIp('2a06:98c0::abcd'), true) // /29
})

test('loopback 與私有網段豁免（修開發者自鎖，零 production 風險）', () => {
  assert.equal(isBlacklistExemptIp('127.0.0.1'), true)
  assert.equal(isBlacklistExemptIp('10.1.2.3'), true)
  assert.equal(isBlacklistExemptIp('172.16.5.5'), true)
  assert.equal(isBlacklistExemptIp('192.168.1.100'), true)
  assert.equal(isBlacklistExemptIp('169.254.1.1'), true)
  assert.equal(isBlacklistExemptIp('::1'), true)
  assert.equal(isBlacklistExemptIp('fe80::1'), true)
  assert.equal(isBlacklistExemptIp('fc00::1234'), true)
})

test('一般公網 IP 不豁免（仍照常比對黑名單）', () => {
  assert.equal(isBlacklistExemptIp('8.8.8.8'), false)
  assert.equal(isBlacklistExemptIp('1.1.1.1'), false) // 1.1.1.1 是 DNS，非 announce 的共用出口
  assert.equal(isBlacklistExemptIp('203.0.113.7'), false)
  assert.equal(isBlacklistExemptIp('172.32.0.1'), false) // 緊鄰 172.16/12 之外
  assert.equal(isBlacklistExemptIp('104.32.0.1'), false) // 緊鄰 104.16/12 之外
  assert.equal(isBlacklistExemptIp('2001:4860:4860::8888'), false) // Google IPv6
})

test('邊界：/12 與 /13+/14 的接縫處', () => {
  assert.equal(isBlacklistExemptIp('104.16.0.0'), true) // /12 起點
  assert.equal(isBlacklistExemptIp('104.31.255.255'), true) // /12 終點
  assert.equal(isBlacklistExemptIp('104.15.255.255'), false) // /12 前一個
  assert.equal(isBlacklistExemptIp('104.32.0.0'), false) // /12 後一個
})

test('無法解析的輸入 fail-safe 為「不豁免」', () => {
  assert.equal(isBlacklistExemptIp(''), false)
  assert.equal(isBlacklistExemptIp('  '), false)
  assert.equal(isBlacklistExemptIp('not-an-ip'), false)
  assert.equal(isBlacklistExemptIp('999.1.1.1'), false)
  assert.equal(isBlacklistExemptIp('1.2.3'), false)
})

test('內嵌 IPv4 的 IPv6（IPv4-mapped）以其 IPv4 判定', () => {
  assert.equal(isBlacklistExemptIp('::ffff:104.28.198.3'), true)
  assert.equal(isBlacklistExemptIp('::ffff:127.0.0.1'), true)
  assert.equal(isBlacklistExemptIp('::ffff:8.8.8.8'), false) // 內嵌一般公網 IPv4
})
