#!/usr/bin/env node
/**
 * npm publish with TOTP from NPM_OTP_SEED (base32 secret, not the 6-digit code).
 * Usage: NPM_OTP_SEED=<base32> node scripts/publish-with-otp.mjs
 */
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let val = 0
  const out = []
  for (const c of s.replace(/[=\s]/g, '').toUpperCase()) {
    const i = A.indexOf(c)
    if (i < 0) continue
    val = (val << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function totp(secretB32) {
  const key = base32Decode(secretB32)
  const counter = Math.floor(Date.now() / 1000 / 30)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(msg).digest()
  const o = h[19] & 15
  const code = h.readUInt32BE(o) & 0x7fffffff
  return String(code % 1_000_000).padStart(6, '0')
}

const seed =
  process.env.NPM_OTP_SEED?.trim() ||
  process.env.NPM_2FA_SECRET?.trim() ||
  process.env.NPM_TOTP_SECRET?.trim()

if (!seed) {
  console.error('Set NPM_OTP_SEED (npm 2FA base32 secret) and retry.')
  process.exit(2)
}

for (let attempt = 0; attempt < 3; attempt++) {
  const otp = totp(seed)
  const r = spawnSync(
    'npm',
    ['publish', '--access', 'public', `--otp=${otp}`],
    { cwd: pkgRoot, stdio: 'inherit', encoding: 'utf8' },
  )
  if (r.status === 0) process.exit(0)
  if (attempt < 2) {
    console.error('EOTP or publish failed — waiting for next TOTP window…')
    await setTimeout(31_000)
  }
}
process.exit(1)