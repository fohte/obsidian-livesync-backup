import type { BackupConfig } from '#config'

import { DirectFileManipulator } from '../vendor-dist/direct-file-manipulator.mjs'

export type VaultFileContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary'; readonly bytes: Buffer }

export interface VaultFile {
  readonly path: string
  readonly content: VaultFileContent
}

export interface VaultFetcher {
  fetchAll(): AsyncIterable<VaultFile>
  close(): Promise<void>
}

// Self-hosted LiveSync entry types (see livesync-bridge common/types.ts):
// - "plain"   → text file (data is UTF-8 string chunks)
// - "newnote" → binary file (data is base64 chunks)
const TEXT_ENTRY_TYPE = 'plain'
const BINARY_ENTRY_TYPE = 'newnote'

// DirectFileManipulatorV2.ts's constructor never calls `ready.reject()` on a
// connection failure, so an unbounded await would hang forever instead of
// surfacing through the normal error-logging path.
const READY_TIMEOUT_MS = 30_000

export class VaultFetcherTimeoutError extends Error {
  override readonly name = 'VaultFetcherTimeoutError'
}

const waitReady = (ready: Promise<void>, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new VaultFetcherTimeoutError(
          `timed out after ${timeoutMs.toString()}ms waiting for the CouchDB connection to become ready`,
        ),
      )
    }, timeoutMs)
    ready.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })

export class LivesyncVaultFetcher implements VaultFetcher {
  private readonly dfm: DirectFileManipulator

  constructor(config: BackupConfig['couchdb']) {
    this.dfm = new DirectFileManipulator({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
      passphrase: config.passphrase,
      obfuscatePassphrase: config.obfuscatePassphrase,
      enableChunkSplitterV2: config.enableChunkSplitterV2,
      enableCompression: config.enableCompression,
      handleFilenameCaseSensitive: config.handleFilenameCaseSensitive,
    })
  }

  async *fetchAll(): AsyncIterable<VaultFile> {
    // DirectFileManipulator connects to CouchDB asynchronously in its
    // constructor; enumerateAllNormalDocs() throws if called beforehand.
    await waitReady(this.dfm.ready.promise, READY_TIMEOUT_MS)
    for await (const entry of this.dfm.enumerateAllNormalDocs({
      metaOnly: false,
    })) {
      if (entry === false) continue
      const path = entry.path
      if (path.length === 0) continue
      const joined = entry.data.join('')
      if (entry.type === BINARY_ENTRY_TYPE) {
        yield {
          path,
          content: { kind: 'binary', bytes: Buffer.from(joined, 'base64') },
        }
      } else if (entry.type === TEXT_ENTRY_TYPE) {
        yield { path, content: { kind: 'text', text: joined } }
      }
      // Other entry types (legacy, internal, etc.) are skipped.
    }
  }

  async close(): Promise<void> {
    await this.dfm.close()
  }
}
