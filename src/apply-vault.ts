import { type Result, ResultAsync } from 'neverthrow'

import { ApplyError, type ApplyStore, type VaultState } from '#apply'
import type { BackupConfig } from '#config'

// eslint-disable-next-line no-restricted-imports -- the generated vendor bundle is external to the app build
import { DirectFileManipulator } from '../vendor-dist/direct-file-manipulator.mjs'

const READY_TIMEOUT_MS = 30_000

interface RawEntry {
  readonly _rev?: string
}

const waitReady = (ready: Promise<void>): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${READY_TIMEOUT_MS.toString()}ms`))
    }, READY_TIMEOUT_MS)
    ready.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (cause: unknown) => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      },
    )
  })

const isPlainTextPath = (path: string): boolean =>
  [
    '.md',
    '.txt',
    '.svg',
    '.html',
    '.csv',
    '.css',
    '.js',
    '.xml',
    '.canvas',
  ].some((extension) => path.endsWith(extension))

export class LivesyncApplyStore implements ApplyStore {
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
    this.dfm.$$getReplicator = () => undefined
  }

  async read(path: string): Promise<Result<VaultState, ApplyError>> {
    const state = await ResultAsync.fromPromise(
      (async (): Promise<VaultState> => {
        await waitReady(this.dfm.ready.promise)
        const id = await this.dfm.path2id(path)
        // Get content and revision from the same database entry for a coherent baseline.
        const entry = await this.dfm.getById(id)
        const content =
          entry === false || entry.deleted === true
            ? undefined
            : Buffer.from(
                entry.data.join(''),
                entry.type === 'newnote' ? 'base64' : 'utf8',
              )
        return {
          content,
          rev: entry === false ? undefined : entry._rev,
        }
      })(),
      () => new ApplyError('failed to read a LiveSync file'),
    )
    return state
  }

  async readRevision(
    path: string,
  ): Promise<Result<string | undefined, ApplyError>> {
    const result = await ResultAsync.fromPromise(
      (async (): Promise<string | undefined> => {
        await waitReady(this.dfm.ready.promise)
        const id = await this.dfm.path2id(path)
        const raw = await this.dfm.rawGet<RawEntry>(id)
        return raw === false ? undefined : raw._rev
      })(),
      () => new ApplyError('failed to read a LiveSync revision'),
    )
    return result
  }

  async put(path: string, content: Buffer): Promise<Result<void, ApplyError>> {
    const result = await ResultAsync.fromPromise(
      (async (): Promise<void> => {
        await waitReady(this.dfm.ready.promise)
        const blob = new Blob([new Uint8Array(content)], {
          type: isPlainTextPath(path)
            ? 'text/plain'
            : 'application/octet-stream',
        })
        const saved = await this.dfm.put(
          path,
          blob,
          {
            ctime: Date.now(),
            mtime: Date.now(),
            size: content.byteLength,
          },
          isPlainTextPath(path) ? 'plain' : 'newnote',
        )
        if (!saved) {
          return Promise.reject(
            new ApplyError('LiveSync rejected a file write'),
          )
        }
      })(),
      () => new ApplyError('failed to write a LiveSync file'),
    )
    return result
  }

  async delete(path: string): Promise<Result<void, ApplyError>> {
    const result = await ResultAsync.fromPromise(
      (async (): Promise<void> => {
        await waitReady(this.dfm.ready.promise)
        const deleted = await this.dfm.delete(path)
        if (!deleted) {
          return Promise.reject(
            new ApplyError('LiveSync rejected a file deletion'),
          )
        }
      })(),
      () => new ApplyError('failed to delete a LiveSync file'),
    )
    return result
  }

  async close(): Promise<Result<void, ApplyError>> {
    const result = await ResultAsync.fromPromise(
      this.dfm.close(),
      () => new ApplyError('failed to close the LiveSync connection'),
    )
    return result
  }
}
