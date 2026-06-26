export type AskCorsOptions = {
  allowedOrigins: ReadonlySet<string> | readonly string[]
  allowedMethods?: string
  allowedHeaders?: string
  maxAgeSeconds?: string
}

const DEFAULT_ALLOWED_METHODS = 'GET, OPTIONS'
const DEFAULT_ALLOWED_HEADERS = 'Content-Type'
const DEFAULT_MAX_AGE_SECONDS = '600'

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('Vary')
  if (!existing) {
    headers.set('Vary', value)
    return
  }
  const values = existing.split(',').map((item) => item.trim().toLowerCase())
  if (!values.includes(value.toLowerCase())) {
    headers.set('Vary', `${existing}, ${value}`)
  }
}

function normalizeAllowedOrigins(
  allowedOrigins: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> {
  if (allowedOrigins instanceof Set) return allowedOrigins
  return new Set(allowedOrigins)
}

export function createAskCors(options: AskCorsOptions): {
  apply(request: Request, response: Response): Response
  preflight(request: Request): Response
  isAllowedOrigin(origin: string | undefined): boolean
} {
  const allowed = normalizeAllowedOrigins(options.allowedOrigins)
  const allowedMethods = options.allowedMethods ?? DEFAULT_ALLOWED_METHODS
  const allowedHeaders = options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS

  function isAllowedOrigin(origin: string | undefined): boolean {
    return origin !== undefined && allowed.has(origin)
  }

  function apply(request: Request, response: Response): Response {
    const origin = request.headers.get('Origin') ?? undefined
    if (!isAllowedOrigin(origin)) return response

    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', origin!)
    headers.set('Access-Control-Allow-Methods', allowedMethods)
    headers.set('Access-Control-Allow-Headers', allowedHeaders)
    headers.set('Access-Control-Max-Age', maxAgeSeconds)
    appendVary(headers, 'Origin')

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  function preflight(request: Request): Response {
    return apply(request, new Response(null, { status: 204 }))
  }

  return { apply, preflight, isAllowedOrigin }
}