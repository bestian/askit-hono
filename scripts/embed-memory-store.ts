import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { loadCagStore, loadEmbeddingsJsonl, LOCAL_EMBED_MODEL, LOCAL_EMBED_URL } from '../src/utils/cagMemories'

type Cli = {
  storeDir: string
  batchSize: number
  progressInterval: number
}

function parseCli(argv: string[]): Cli {
  let storeDir = '/tmp/cag-memories-full105'
  let batchSize = 128
  let progressInterval = 2000

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--store' && argv[i + 1]) {
      storeDir = argv[++i]
    } else if (arg === '--batch-size' && argv[i + 1]) {
      batchSize = parseInt(argv[++i], 10)
    } else if (arg === '--progress' && argv[i + 1]) {
      progressInterval = parseInt(argv[++i], 10)
    }
  }

  return { storeDir: path.resolve(storeDir), batchSize, progressInterval }
}

async function embedBatchWithRetry(texts: string[], maxRetries = 3): Promise<number[][]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(LOCAL_EMBED_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: LOCAL_EMBED_MODEL, input: texts }),
      })
      if (!res.ok) {
        throw new Error(`Ollama embed returned HTTP ${res.status}: ${await res.text()}`)
      }
      const body = (await res.json()) as { embeddings?: number[][] }
      if (!body.embeddings || body.embeddings.length !== texts.length) {
        throw new Error(`Expected ${texts.length} embeddings, got ${body.embeddings?.length}`)
      }
      return body.embeddings
    } catch (err) {
      if (attempt === maxRetries) throw err
      console.error(`Retry ${attempt}/${maxRetries} after error:`, err)
      await new Promise<void>((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
  throw new Error('Unreachable')
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  console.log(`Loading CAG store from ${cli.storeDir}...`)

  const store = loadCagStore(cli.storeDir)
  const totalMemories = store.memories.length
  console.log(`Store loaded: ${totalMemories} memories, ${store.links.length} links`)

  const existingMap = loadEmbeddingsJsonl(cli.storeDir)
  console.log(`Existing embeddings: ${existingMap.size}`)

  const pending = store.memories.filter((m) => !existingMap.has(m.id))
  console.log(`Pending embeddings to compute: ${pending.length}`)

  if (pending.length === 0) {
    console.log('All memories already embedded.')
    return
  }

  const embeddingsPath = path.join(cli.storeDir, 'embeddings.jsonl')
  const startTime = Date.now()
  let doneCount = existingMap.size
  let lastProgressReport = doneCount

  for (let i = 0; i < pending.length; i += cli.batchSize) {
    const batch = pending.slice(i, i + cli.batchSize)
    const texts = batch.map((m) => m.content)
    const vectors = await embedBatchWithRetry(texts)

    const lines = batch.map((m, idx) => JSON.stringify({ id: m.id, vector: vectors[idx] }))
    appendFileSync(embeddingsPath, lines.join('\n') + '\n', 'utf8')

    doneCount += batch.length

    if (doneCount - lastProgressReport >= cli.progressInterval || doneCount === totalMemories) {
      const elapsedSec = (Date.now() - startTime) / 1000
      const processedThisRun = doneCount - existingMap.size
      const rate = processedThisRun / Math.max(0.001, elapsedSec)
      console.log(
        `[Progress] ${doneCount}/${totalMemories} memories embedded (${processedThisRun} done in ${elapsedSec.toFixed(1)}s, ${rate.toFixed(1)} texts/s)`,
      )
      lastProgressReport = doneCount
    }
  }

  const totalElapsedSec = (Date.now() - startTime) / 1000
  const processedThisRun = doneCount - existingMap.size
  const avgRate = processedThisRun / Math.max(0.001, totalElapsedSec)

  console.log(`\n=== Embedding Complete ===`)
  console.log(`Total memories in store: ${totalMemories}`)
  console.log(`Total embeddings computed this run: ${processedThisRun}`)
  console.log(`Total wall-clock time: ${totalElapsedSec.toFixed(2)}s (${(totalElapsedSec / 60).toFixed(2)} min)`)
  console.log(`Average throughput: ${avgRate.toFixed(2)} texts/s`)

  // Verification
  const verifyMap = loadEmbeddingsJsonl(cli.storeDir)
  console.log(`Verified embeddings.jsonl size: ${verifyMap.size}`)
  if (verifyMap.size !== totalMemories) {
    throw new Error(`Embedding count mismatch: expected ${totalMemories}, got ${verifyMap.size}`)
  }
}

main().catch((err) => {
  console.error('Fatal error during embedding:', err)
  process.exit(1)
})
