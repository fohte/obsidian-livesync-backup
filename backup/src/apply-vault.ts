import { isUtf8 } from 'node:buffer'

import { createLivesyncClient } from 'livesync/livesync-client'
import { waitForLivesyncReady } from 'livesync/ready'
import { err, ok, type Result, ResultAsync } from 'neverthrow'

import { ApplyError, type ApplyStore, type VaultState } from '#apply'
import type { BackupConfig } from '#config'

const READY_TIMEOUT_MS = 120_000

interface RawEntry {
  readonly ctime?: number
  readonly _rev?: string
}

interface LiveSyncMetadataDocument {
  readonly _id: string
  readonly _rev?: string
}

interface LiveSyncPutOptions {
  readonly force?: boolean
}

interface LiveSyncDatabase {
  put(
    doc: LiveSyncMetadataDocument,
    options?: LiveSyncPutOptions,
  ): Promise<unknown>
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

class LivesyncWriteError extends ApplyError {
  override readonly name = 'LivesyncWriteError'

  constructor(
    readonly originalCause: unknown,
    path: string,
    operation: 'write' | 'delete',
  ) {
    super('failed to update a LiveSync file', { path, operation })
  }
}

const isPlainTextContent = (content: Buffer): boolean =>
  // The backup reader only scans UTF-8 text entries for configured secrets.
  !content.includes(0) && isUtf8(content)

const hasHttpStatus = (cause: unknown, status: number): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'status' in cause &&
  cause.status === status

const isMissingDocumentError = (cause: unknown): boolean =>
  hasHttpStatus(cause, 404)

const isRevisionConflictError = (cause: unknown): boolean =>
  hasHttpStatus(cause, 409)

const withRevisionGuard = <T>(
  database: LiveSyncDatabase,
  id: string,
  expectedRevision: string | undefined,
  write: () => Promise<T>,
): Promise<T> => {
  const originalPut = database.put.bind(database)
  database.put = (doc, options) => {
    if (doc._id !== id) return originalPut(doc, options)
    if (doc._rev !== expectedRevision) {
      return Promise.reject(
        Object.assign(new Error('LiveSync file revision changed'), {
          status: 409,
        }),
      )
    }

    // PouchDB's force option bypasses stale-revision rejection, so use normal MVCC for this write.
    return originalPut(doc, { ...options, force: false })
  }

  return Promise.resolve()
    .then(write)
    .finally(() => {
      database.put = originalPut
    })
}

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
    const rawEntryResult = await ResultAsync.fromPromise(
      this.dfm.rawGet<RawEntry>(idResult.value),
      (cause: unknown) => new LivesyncReadError(cause, path),
    )
    if (rawEntryResult.isErr()) return err(rawEntryResult.error)
    const rawEntry = rawEntryResult.value

    return ok({
      content:
        entry === false || entry.deleted === true
          ? undefined
          : Buffer.from(
              entry.data.join(''),
              entry.type === 'newnote' ? 'base64' : 'utf8',
            ),
      rev: entry === false ? undefined : entry._rev,
      ...(entry !== false &&
      entry.deleted !== true &&
      rawEntry !== false &&
      typeof rawEntry.ctime === 'number'
        ? { ctime: rawEntry.ctime }
        : {}),
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

  async put(
    path: string,
    content: Buffer,
    expectedRevision: string | undefined,
    ctime?: number,
  ): Promise<Result<boolean, ApplyError>> {
    const result = await ResultAsync.fromPromise(
      (async (): Promise<boolean> => {
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
        const database = this.dfm.liveSyncLocalDB.localDatabase
        const plainText = isPlainTextContent(content)
        const blob = new Blob([new Uint8Array(content)], {
          type: plainText ? 'text/plain' : 'application/octet-stream',
        })
        const saved = await withRevisionGuard(
          database,
          id,
          expectedRevision,
          () =>
            this.dfm.put(
              path,
              blob,
              {
                ctime: ctime ?? Date.now(),
                mtime: Date.now(),
                size: content.byteLength,
              },
              plainText ? 'plain' : 'newnote',
            ),
        )
        if (!saved) {
          return Promise.reject(
            new ApplyError('LiveSync rejected a file write'),
          )
        }
        return true
      })(),
      (cause) => new LivesyncWriteError(cause, path, 'write'),
    )
    if (result.isErr()) {
      if (isRevisionConflictError(result.error.originalCause)) return ok(false)
      return err(result.error)
    }
    return result
  }

  async delete(
    path: string,
    expectedRevision: string | undefined,
  ): Promise<Result<boolean, ApplyError>> {
    if (expectedRevision === undefined) return ok(false)

    const result = await ResultAsync.fromPromise(
      (async (): Promise<boolean> => {
        await waitForLivesyncReady(
          this.dfm.ready.promise,
          READY_TIMEOUT_MS,
          (timeoutMs) =>
            new ApplyError(
              `timed out after ${timeoutMs.toString()}ms waiting for CouchDB`,
              { path, operation: 'connect' },
            ),
        )
        const deleted = await this.dfm.liveSyncLocalDB.deleteDBEntry(path, {
          rev: expectedRevision,
        })
        return deleted
      })(),
      (cause) => new LivesyncWriteError(cause, path, 'delete'),
    )
    if (result.isErr()) {
      if (isRevisionConflictError(result.error.originalCause)) return ok(false)
      return err(result.error)
    }
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
