# Consuming `@au/cf-ai-gateway`

## npm

```bash
npm install @au/cf-ai-gateway
# or: bun add @au/cf-ai-gateway
```

Published tarball includes prebuilt `dist/` only (no runtime dependencies).

**plurality-ask:** `npm install @au/cf-ai-gateway` (e.g. `^0.1.2`). Bump `version` in package.json before each publish (registry already has 0.1.0).

## Maintainers (askit-hono)

```bash
npm run build -w @au/cf-ai-gateway
npm run publish:otp -w @au/cf-ai-gateway   # needs NPM_OTP_SEED (base32); or npm publish --otp=<6-digit>
```

Bump `version` in `packages/cf-ai-gateway/package.json` before publish.

## Vendored tarball (optional)

```bash
npm run pack:gateway
# → plurality.net/worker/vendor/au-cf-ai-gateway-<version>.tgz
```

## Inside askit-hono

`workspace:*` on `@au/cf-ai-gateway`.