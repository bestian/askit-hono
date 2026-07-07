### Task 1: Scaffold workspace package

**Files:**
- Create: `packages/cf-ai-gateway/package.json`
- Create: `packages/cf-ai-gateway/tsconfig.json`
- Modify: `package.json` (root workspaces)

**Interfaces:**
- Produces: npm package name `@audreyt/cf-ai-gateway` version `0.1.0`.

- [ ] **Step 1: Add workspaces to root `package.json`**

```json
"workspaces": ["packages/*"],
"dependencies": {
  "@audreyt/cf-ai-gateway": "workspace:*",
  ...
}
```

- [ ] **Step 2: Create `packages/cf-ai-gateway/package.json`**

```json
{
  "name": "@audreyt/cf-ai-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./loadDevVars": "./src/loadDevVars.ts",
    "./verify-baseten": "./scripts/verify-baseten.ts"
  },
  "scripts": {
    "test": "node --import tsx --test test/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "tsx": "^4.21.0",
    "typescript": "^5.7.2"
  }
}
```

- [ ] **Step 3: Create `packages/cf-ai-gateway/tsconfig.json`**

Use strict TypeScript, `moduleResolution: "bundler"`, `module: "ESNext"`, `target: "ES2022"`, `noEmit: true`, include `src/**/*`, `test/**/*`, `scripts/**/*`.

- [ ] **Step 4: Create minimal `packages/cf-ai-gateway/src/index.ts`**

```ts
// Phase 1 scaffold — exports added in later tasks.
export {}
```

- [ ] **Step 5: `npm install` at repo root**

Run: `npm install`
Expected: lockfile updates; workspace links `@audreyt/cf-ai-gateway`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json packages/cf-ai-gateway/
git commit -m "chore: scaffold @audreyt/cf-ai-gateway workspace"
```

**Do NOT** skip commit. **Do NOT** run full test suite yet (no tests in package).