# Consuming `@audreyt/cf-ai-gateway` outside askit-hono

The package is **private** (not on public npm in v1). It ships **built** `dist/` via `npm run build` (`prepare` runs on install).

## Recommended: git submodule in `plurality.net`

```bash
# From plurality.net repo root (once)
git submodule add https://github.com/bestian/askit-hono.git vendor/askit-hono
git submodule update --init --recursive
```

`worker/package.json`:

```json
"@audreyt/cf-ai-gateway": "file:../vendor/askit-hono/packages/cf-ai-gateway"
```

After clone / CI:

```bash
git submodule update --init --depth 1 vendor/askit-hono
cd worker && bun install   # runs package prepare → tsc build
```

### Local monorepo (optional)

If `askit-hono` and `plurality.net` are siblings on one machine **before** the submodule
points at a commit with `dist` build, you may temporarily set:

`file:../../askit-hono/packages/cf-ai-gateway` in `worker/package.json`.

**CI and clones must use `vendor/askit-hono` only.**

Bump the submodule commit when you need a newer gateway; run `npm test` in askit-hono before pinning.

## Not supported for production

- `file:../../askit-hono/...` — breaks unless repos are siblings on disk.
- `workspace:*` — only inside askit-hono npm workspaces.

## Future

Publish to GitHub Packages or npm when `private: false` and versioned releases exist.