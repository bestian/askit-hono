# Consuming `@au/cf-ai-gateway`

## npm

```bash
npm install @au/cf-ai-gateway
# or: bun add @au/cf-ai-gateway
```

Published tarball includes prebuilt `dist/` only (no runtime dependencies).

**plurality-ask:** `"@au/cf-ai-gateway": "^0.1.0"`

## Maintainers (askit-hono)

```bash
npm run build -w @au/cf-ai-gateway
npm run publish:gateway
```

Bump `version` in `packages/cf-ai-gateway/package.json` before publish.

## Vendored tarball (optional)

```bash
npm run pack:gateway
# → plurality.net/worker/vendor/au-cf-ai-gateway-<version>.tgz
```

## Inside askit-hono

`workspace:*` on `@au/cf-ai-gateway`.