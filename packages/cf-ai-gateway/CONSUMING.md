# Consuming `@audreyt/cf-ai-gateway`

## npm (recommended)

```bash
npm install @audreyt/cf-ai-gateway
# or: bun add @audreyt/cf-ai-gateway
```

Published package includes prebuilt `dist/`. No askit-hono checkout required.

**plurality-ask worker:** pin semver in `package.json`, e.g. `"@audreyt/cf-ai-gateway": "^0.1.0"`.

## Maintainers (askit-hono)

```bash
npm run build -w @audreyt/cf-ai-gateway
npm run publish:gateway   # requires npm login + 2FA OTP if enabled
```

Bump `version` in `packages/cf-ai-gateway/package.json` before publish.

## Optional: vendored tarball

For air-gapped or pre-release pins:

```bash
npm run pack:gateway
# audreyt-cf-ai-gateway-<version>.tgz → plurality.net/worker/vendor/
```

`file:vendor/audreyt-cf-ai-gateway-0.1.0.tgz` — prefer npm once published.

## Inside askit-hono

`workspace:*` in root `package.json` (develop against `src/`).