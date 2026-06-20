// Issue #49 / #50 — 共用基礎設施網段的「永久黑名單」豁免。
//
// 自動黑名單（src/utils/abuse.ts）以來源 IP 為 key 永久封鎖累犯。問題在於：
// Cloudflare WARP 的消費端出口、Cloudflare 邊緣、loopback／私有網段這些位址，
// 「一個 IP 背後是成千上萬個使用者」且會輪換出口。對它們做永久封鎖會：
//   1. 誤傷一整票共用同一出口的無辜使用者；
//   2. 把走 WARP 的開發者自己鎖在門外——`npm run preview`（wrangler dev --remote）
//      時 cf-connecting-ip 就是 WARP 出口（如 104.28.198.3），首頁的 /capacity、
//      /au 請求被 403（issue #49）；
//   3. 對會輪換出口的攻擊者其實也擋不住。
//
// 因此這些網段一律豁免「永久黑名單」的「寫入」與「比對」兩端。
// 重點：豁免的「只有」黑名單這一層——每 IP 即時限流（DO）與全域生成預算
// 仍照常生效，所以共用出口依然被即時節流，不會給攻擊者新的可乘之機。

// Cloudflare 對外 announce 的位址空間（whois: CLOUDFLARENET）。
//
// 注意 104.16.0.0/12：官方「CDN 邊緣」清單把這塊切成 104.16.0.0/13 +
// 104.24.0.0/14（只到 104.27.x）。但 WARP 消費端出口（issue #50 的實際肇因
// 104.28.198.3）落在 104.28.x，在那份較窄的 ingress 清單之外、卻仍在 Cloudflare
// 對外 announce 的完整 /12（104.16.x–104.31.x）內。我們要豁免的是「共用出口」，
// 所以採用完整 /12，把 WARP 出口一併涵蓋。其餘沿用官方公布清單。
const CLOUDFLARE_V4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/12', // 完整 /12，含 WARP 出口 104.28.x（見上）
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const

const CLOUDFLARE_V6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const

// loopback／私有／link-local。production 的 cf-connecting-ip 由 Cloudflare 邊緣
// 填入真實客戶端 IP，永遠不會是這些位址；因此豁免它們「只」影響本機 dev
// （wrangler dev 可能把 cf-connecting-ip 設成 127.0.0.1），對 production 零風險，
// 但能避免不走 WARP 的開發者也把自己鎖住。
const PRIVATE_V4 = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
] as const

const PRIVATE_V6 = ['::1/128', 'fc00::/7', 'fe80::/10'] as const

type Cidr4 = { base: number; bits: number }
type Cidr6 = { base: bigint; bits: number }

function parseIpv4(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value >>> 0
}

function parseIpv6(input: string): bigint | null {
  let ip = input
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)

  // 內嵌 IPv4（如 ::ffff:1.2.3.4）：把尾端 IPv4 轉成兩個 16-bit 群組。
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':')
    if (lastColon === -1) return null
    const v4 = parseIpv4(ip.slice(lastColon + 1))
    if (v4 === null) return null
    const hi = ((v4 >>> 16) & 0xffff).toString(16)
    const lo = (v4 & 0xffff).toString(16)
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = ip.split('::')
  if (halves.length > 2) return null
  const toGroups = (s: string): string[] => (s === '' ? [] : s.split(':'))
  const head = toGroups(halves[0])
  const tail = halves.length === 2 ? toGroups(halves[1]) : null

  let groups: string[]
  if (tail === null) {
    groups = head
  } else {
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null
    groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
  }
  if (groups.length !== 8) return null

  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    value = (value << 16n) + BigInt(Number.parseInt(group, 16))
  }
  return value
}

function parseCidr4(cidr: string): Cidr4 {
  const [addr, bitsStr] = cidr.split('/')
  const base = parseIpv4(addr)
  if (base === null) throw new Error(`不合法的 IPv4 CIDR：${cidr}`)
  return { base, bits: Number(bitsStr) }
}

function parseCidr6(cidr: string): Cidr6 {
  const [addr, bitsStr] = cidr.split('/')
  const base = parseIpv6(addr)
  if (base === null) throw new Error(`不合法的 IPv6 CIDR：${cidr}`)
  return { base, bits: Number(bitsStr) }
}

function inCidr4(ip: number, cidr: Cidr4): boolean {
  if (cidr.bits === 0) return true
  // bits 介於 1..32：左移 (32-bits) 後 >>> 0 取無號 32-bit 遮罩。
  const mask = (0xffffffff << (32 - cidr.bits)) >>> 0
  return ((ip & mask) >>> 0) === ((cidr.base & mask) >>> 0)
}

function inCidr6(ip: bigint, cidr: Cidr6): boolean {
  if (cidr.bits === 0) return true
  const shift = BigInt(128 - cidr.bits)
  return ip >> shift === cidr.base >> shift
}

const CLOUDFLARE_V4_CIDRS = CLOUDFLARE_V4.map(parseCidr4)
const PRIVATE_V4_CIDRS = PRIVATE_V4.map(parseCidr4)
const EXEMPT_V4_CIDRS = [...CLOUDFLARE_V4_CIDRS, ...PRIVATE_V4_CIDRS]

const CLOUDFLARE_V6_CIDRS = CLOUDFLARE_V6.map(parseCidr6)
const PRIVATE_V6_CIDRS = PRIVATE_V6.map(parseCidr6)
const EXEMPT_V6_CIDRS = [...CLOUDFLARE_V6_CIDRS, ...PRIVATE_V6_CIDRS]

// 來源 IP 是否屬於「永久黑名單豁免」的共用基礎設施網段
// （Cloudflare／WARP 出口、loopback、私有網段）。無法解析的 IP 視為不豁免
// （fail-safe：寧可照常比對黑名單，也不誤放）。
export function isBlacklistExemptIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase()
  if (!normalized) return false
  if (normalized.includes(':')) {
    const value = parseIpv6(normalized)
    if (value === null) return false
    // IPv4-mapped IPv6（::ffff:a.b.c.d，即 ::ffff:0:0/96）：以內嵌的 IPv4 判定，
    // 否則同一個 IPv4 換成 mapped 寫法就會繞過豁免。
    if (value >> 32n === 0xffffn) {
      const v4 = Number(value & 0xffffffffn)
      return EXEMPT_V4_CIDRS.some((cidr) => inCidr4(v4, cidr))
    }
    return EXEMPT_V6_CIDRS.some((cidr) => inCidr6(value, cidr))
  }
  const value = parseIpv4(normalized)
  if (value === null) return false
  return EXEMPT_V4_CIDRS.some((cidr) => inCidr4(value, cidr))
}
