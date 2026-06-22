/**
 * Create or update the Sakana custom provider on Cloudflare AI Gateway.
 *
 * Requires:
 *   CLOUDFLARE_API_TOKEN — AI Gateway - Edit (management API)
 *   SAKANA_API_KEY — upstream Sakana auth (verification only; not stored in CF)
 *
 * Optional for route verification:
 *   CF_AIG_TOKEN — defaults to CLOUDFLARE_API_TOKEN
 *
 * Usage:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/setup-fugu-cloudflare-provider.ts
 */

const ACCOUNT_ID = '99984e3c707dd2518f73dfa9da3fc887'
const GATEWAY_ID = 'kami'

const desired = {
  name: 'Sakana Fugu',
  slug: 'sakana',
  base_url: 'https://api.sakana.ai',
  description:
    'Sakana AI OpenAI Responses provider for the Fugu models used by OMP: fugu and fugu-ultra.',
  link: 'https://api.sakana.ai',
  enable: true,
  beta: false,
  curl_example:
    `curl https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/custom-sakana/v1/responses ` +
    `-H 'Authorization: Bearer $SAKANA_API_KEY' -H 'cf-aig-authorization: Bearer $CF_AIG_TOKEN' ` +
    `-H 'Content-Type: application/json' ` +
    `-d '{"model":"fugu","input":"Reply with exactly FUGU_CF_OK.","stream":false,"max_output_tokens":4096}'`,
}

async function cfRequest(
  token: string,
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

function extractAssistantText(data: Record<string, unknown>): string {
  const top = data.output_text
  if (typeof top === 'string' && top) return top
  const parts: string[] = []
  const output = data.output
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      if (row.type !== 'message') continue
      const content = row.content
      if (!Array.isArray(content)) continue
      for (const c of content) {
        if (!c || typeof c !== 'object') continue
        const cell = c as Record<string, unknown>
        if (cell.type === 'output_text' || cell.type === 'text') {
          const t = cell.text
          if (typeof t === 'string') parts.push(t)
        }
      }
    }
  }
  return parts.join('')
}

async function verifyRoute(sakanaKey: string, cfAig: string | undefined): Promise<void> {
  const url = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/custom-sakana/v1/responses`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sakanaKey}`,
    'Content-Type': 'application/json',
  }
  if (cfAig) headers['cf-aig-authorization'] = `Bearer ${cfAig}`

  for (const cap of [4096, 8192]) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'fugu',
        input: 'Reply with exactly FUGU_CF_OK.',
        stream: false,
        max_output_tokens: cap,
      }),
    })
    const raw = await res.text()
    if (!res.ok) {
      throw new Error(`route verify HTTP ${res.status}: ${raw.slice(0, 2000)}`)
    }
    let data: Record<string, unknown>
    try {
      data = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error(`route verify: not JSON: ${raw.slice(0, 500)}`)
    }
    if (!(data.object === 'response' || ('status' in data && 'usage' in data))) {
      throw new Error(`route verify: not a Responses object: ${raw.slice(0, 500)}`)
    }
    const text = extractAssistantText(data)
    const status = data.status
    const reason = (data.incomplete_details as { reason?: string } | undefined)?.reason
    if (text.includes('FUGU_CF_OK')) {
      console.log(`fugu route ok: marker found (cap=${cap})`)
      return
    }
    if (status === 'incomplete' || reason === 'max_output_tokens') {
      console.log(`fugu routing ok but truncated at cap=${cap}; retrying`)
      continue
    }
    console.log(`fugu route ok: valid Responses object; visible=${JSON.stringify(text.slice(0, 120))}`)
    return
  }
  console.log('fugu routing ok: stayed incomplete; raise cap or lower reasoning effort')
}

async function main(): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim()
  const sakana = process.env.SAKANA_API_KEY?.trim()
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required (AI Gateway - Edit)')
  if (!sakana) throw new Error('SAKANA_API_KEY is required')

  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/custom-providers`
  let { status, json } = await cfRequest(token, 'GET', `${base}?search=sakana&per_page=100`)
  if (status >= 400 || json.success !== true) {
    throw new Error(`list failed: HTTP ${status} ${JSON.stringify(json)}`)
  }
  const listed = (json.result ?? []) as Array<Record<string, unknown>>
  const exact = listed.filter((p) => p.slug === 'sakana')

  let action: string
  if (exact.length > 0) {
    const id = String(exact[0].id)
    ;({ status, json } = await cfRequest(token, 'PATCH', `${base}/${id}`, desired))
    action = 'patched'
  } else {
    ;({ status, json } = await cfRequest(token, 'POST', base, desired))
    action = 'created'
    if (status === 409) {
      ;({ status, json } = await cfRequest(token, 'GET', `${base}?search=sakana&per_page=100`))
      const again = ((json.result ?? []) as Array<Record<string, unknown>>).filter(
        (p) => p.slug === 'sakana',
      )
      if (!again.length) throw new Error('duplicate slug but provider not listed')
      ;({ status, json } = await cfRequest(token, 'PATCH', `${base}/${again[0].id}`, desired))
      action = 'patched-after-409'
    }
  }

  if (status >= 400 || json.success !== true) {
    throw new Error(`${action} failed: HTTP ${status} ${JSON.stringify(json)}`)
  }

  const provider = json.result as Record<string, unknown>
  for (const [key, expected] of Object.entries({
    slug: 'sakana',
    name: 'Sakana Fugu',
    base_url: 'https://api.sakana.ai',
    enable: true,
  })) {
    if (provider[key] !== expected) {
      throw new Error(`bad ${key}: got ${JSON.stringify(provider[key])}, expected ${JSON.stringify(expected)}`)
    }
  }
  console.log(
    `${action}: ${provider.id} ${provider.slug} ${provider.base_url} enable=${provider.enable}`,
  )

  const cfAig = process.env.CF_AIG_TOKEN?.trim() || token
  await verifyRoute(sakana, cfAig)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})