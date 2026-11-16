import { isUtf8 } from 'node:buffer'

import { err, ok, type Result, ResultAsync } from 'neverthrow'

import { ApplyError, type ApplyStore, type VaultState } from '#apply'
import type { BackupConfig } from '#config'
import { createLivesyncClient, waitForLivesyncReady } from '#livesync-client'

const READY_TIMEOUT_MS = 30_000

interface RawEntry {
  readonly _rev?: string
}

class LivesyncReadError extends ApplyError {
  override readonly name = 'LivesyncReadError'

  constructor(
    readonly originalCause: unknown,
    path: string,
  ) {
    super('failed to read a LiveSync file', { path, operation: 'read' })
  }
}

const isPlainTextContent = (content: Buffer): boolean =>
  // The backup reader only scans UTF-8 text entries for configured secrets.
  !content.includes(0) && isUtf8(content)

const isMissingDocumentError = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'status' in cause &&
  cause.status === 404

export class LivesyncApplyStore implements ApplyStore {
  private readonly dfm: ReturnType<typeof createLivesyncClient>

  constructor(config: BackupConfig['couchdb']) {
    this.dfm = createLivesyncClient(config)
  }

  async read(path: string): Promise<Result<VaultState, ApplyError>> {
    const idResult = await ResultAsync.fromPromise(
      (async (): Promise<string> => {
        await waitForLivesyncReady(
          this.dfm.ready.promise,
          READY_TIMEOUT_MS,
          (timeoutMs) =>
            new ApplyError(
              `timed out after ${timeoutMs.toString()}ms waiting for CouchDB`,
              { path, operation: 'connect' },
            ),
        )
        return this.dfm.path2id(path)
      })(),
      () =>
        new ApplyError('failed to read a LiveSync file', {
          path,
          operation: 'read',
        }),
    )
    if (idResult.isErr()) return err(idResult.error)

    const entryResult = await ResultAsync.fromPromise(
      this.dfm.getById(idResult.value),
      (cause: unknown) => new LivesyncReadError(cause, path),
    )
    if (entryResult.isErr()) {
      if (isMissingDocumentError(entryResult.error.originalCause)) {
        return ok({ content: undefined, rev: undefined })
      }
      return err(entryResult.error)
    }

    const entry = entryResult.value
    return ok({
      content:
        entry === false || entry.deleted === true
          ? undefined
          : Buffer.from(
              entry.data.join(''),
              entry.type === 'newnote' ? 'base64' : 'utf8',
            ),
      rev: entry === false ? undefined : entry._rev,
    })
  }

  async readRevision(
    path: string,
  ): Promise<Result<string | undefined, ApplyError>> {
    const result = await ResultAsync.fromPromise(
      (async (): Promise<string | undefined> => {
        await waitForLivesyncReady(
          this.dfm.ready.promise,
          READY_TIMEOUT_MS,
          (timeoutMs) =>
            new ApplyError(
              `timed out after ${timeoutMs.toString()}ms waiting for CouchDB`,
              { path, operation: 'connect' },
            ),
        )
        const id = await this.dfm.path2id(path)
        const raw = await this.dfm.rawGet<RawEntry>(id)
        return raw === false ? undefined : raw._rev
      })(),
      () =>
        new ApplyError('failed to read a LiveSync revision', {
          path,
          operation: 'revision_check',
        }),
    )
    return result
  }

  async put(path: string, content: Buffer): Promise<Result<void, ApplyError>> {
    const result = await ResultAsync.fromPromise(
      (async (): Promise<void> => {
        await waitForLivesyncReady(
          this.dfm.ready.promise,
          READY_TIMEOUT_MS,
          (timeoutMs) =>
            new ApplyError(
              `timed out after ${timeoutMs.toString()}ms waiting for CouchDB`,
              { path, operation: 'connect' },
            ),
        )
        const plainText = isPlainTextContent(content)
        const blob = new Blob([new Uint8Array(content)], {
          type: plainText ? 'text/plain' : 'application/octet-stream',
        })
        const saved = await this.dfm.put(
          path,
          blob,
          {
            ctime: Date.now(),
            mtime: Date.now(),
            size: content.byteLength,
          },
          plainText ? 'plain' : 'newnote',
        )
        if (!saved) {
          return Promise.reject(
            new ApplyError('LiveSync rejected a file write'),
          )
        }
      })(),
      () =>
        new ApplyError('failed to write a LiveSync file', {
          path,
          operation: 'write',
        }),
    )
    return result
  }

  async delete(path: string): Promise<Result<void, ApplyError>> {
    const result = await ResultAsync.fromPromise(
      (async (): Promise<void> => {
        await waitForLivesyncReady(
          this.dfm.ready.promise,
          READY_TIMEOUT_MS,
          (timeoutMs) =>
            new ApplyError(
              `timed out after ${timeoutMs.toString()}ms waiting for CouchDB`,
              { path, operation: 'connect' },
            ),
        )
        const deleted = await this.dfm.delete(path)
        if (!deleted) {
          return Promise.reject(
            new ApplyError('LiveSync rejected a file deletion'),
          )
        }
      })(),
      () =>
        new ApplyError('failed to delete a LiveSync file', {
          path,
          operation: 'delete',
        }),
    )
    return result
  }

  async close(): Promise<Result<void, ApplyError>> {
    const result = await ResultAsync.fromPromise(
      this.dfm.close(),
      () =>
        new ApplyError('failed to close the LiveSync connection', {
          operation: 'close',
        }),
    )
    return result
  }
}
