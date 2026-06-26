# Consuming `@audreyt/cf-ai-gateway` outside askit-hono

**Mechanism (v1):** commit a prebuilt **npm pack tarball** in `plurality.net/worker/vendor/`.

The tarball includes only `dist/` (`files: ["dist"]` in package.json). No git submodule, no sibling `file:` path, no install-time build.

**Tarball filename:** `npm pack` emits `audreyt-cf-ai-gateway-<version>.tgz` (scope `@` → `audreyt-`). Do not use `cf-ai-gateway-….tgz` in `file:` paths.

## Refresh tarball (askit-hono maintainers)

From askit-hono repo root (requires `plurality.net` as sibling for default output path):

```bash
npm run pack:gateway
# writes ../plurality.net/worker/vendor/audreyt-cf-ai-gateway-0.1.0.tgz
```

Or from the package:

```bash
npm run build -w @audreyt/cf-ai-gateway
cd packages/cf-ai-gateway && npm pack --pack-destination /path/to/plurality.net/worker/vendor
```

Commit the updated `.tgz` in plurality.net when gateway APIs change.

## plurality-ask worker

`worker/package.json`:

```json
"@audreyt/cf-ai-gateway": "file:vendor/audreyt-cf-ai-gateway-0.1.0.tgz"
```

Clone / CI: `cd worker && bun install` — no askit-hono checkout required.

## Inside askit-hono

`workspace:*` in root `package.json` (source `src/`, not tarball).

## Future

Publish to GitHub Packages / npm when `private: false`.