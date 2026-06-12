/**
 * Build env for wrangler subprocesses.
 *
 * Local dev often keeps a low-permission CLOUDFLARE_API_TOKEN (Workers AI only)
 * in .dev.vars for REST embedding. Passing it to wrangler shadows OAuth and
 * breaks d1 / vectorize. CI has no OAuth session and must keep the token.
 */
export function buildWranglerEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source }
  const useApiToken =
    source.WRANGLER_USE_API_TOKEN === '1' ||
    source.GITHUB_ACTIONS === 'true' ||
    source.CI === 'true'
  if (!useApiToken) {
    delete env.CLOUDFLARE_API_TOKEN
  }
  return env
}