import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Load `.dev.vars` into process.env (wrangler-style KEY=VALUE), without overriding set vars. */
export function loadDevVars(cwd = process.cwd()): void {
  let raw = ''
  try {
    raw = readFileSync(path.resolve(cwd, '.dev.vars'), 'utf-8')
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : null
    if (code === 'ENOENT') return
    throw e
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const normalized = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed
    const eq = normalized.indexOf('=')
    if (eq <= 0) continue

    const key = normalized.slice(0, eq).trim()
    let value = normalized.slice(eq + 1).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value
    }
  }
}