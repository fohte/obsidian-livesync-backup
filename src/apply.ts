import { createHash } from 'node:crypto'

import { err, ok, type Result, ResultAsync } from 'neverthrow'

export class ApplyError extends Error {
  override readonly name: string = 'ApplyError'

  constructor(
    message: string,
    readonly context?: { readonly path?: string; readonly operation?: string },
  ) {
    super(message)
  }
}

export interface ApplyBlob {
  readonly objectId: string
  readonly objectFormat: 'sha1' | 'sha256'
  read(): Promise<Result<Buffer, ApplyError>>
}

export type ApplyContent = Buffer | ApplyBlob | undefined

export interface ApplyFileChange {
  readonly commit: string
  readonly path: string
  readonly before: ApplyContent
  readonly after: ApplyContent
}

export interface VaultState {
  readonly content: Buffer | undefined
  readonly rev: string | undefined
}

export interface ApplyStore {
  read(path: string): Promise<Result<VaultState, ApplyError>>
  readRevision(path: string): Promise<Result<string | undefined, ApplyError>>
  put(path: string, content: Buffer): Promise<Result<void, ApplyError>>
  delete(path: string): Promise<Result<void, ApplyError>>
}

export interface ApplyConflict {
  readonly commit: string
  readonly path: string
}

export interface ApplyOutcome {
  readonly applied: number
  readonly skipped: number
  readonly conflicts: readonly ApplyConflict[]
}

const gitBlobObjectId = (
  content: Buffer,
  objectFormat: ApplyBlob['objectFormat'],
): string =>
  createHash(objectFormat)
    .update(`blob ${content.byteLength.toString()}\0`)
    .update(content)
    .digest('hex')

const equal = (
  actual: Buffer | undefined,
  expected: ApplyContent,
): Promise<Result<boolean, ApplyError>> => {
  if (actual === undefined || expected === undefined) {
    return Promise.resolve(ok(actual === expected))
  }
  if (Buffer.isBuffer(expected)) {
    return Promise.resolve(ok(actual.equals(expected)))
  }
  if (gitBlobObjectId(actual, expected.objectFormat) !== expected.objectId) {
    return Promise.resolve(ok(false))
  }
  return expected.read().then((result) => {
    if (result.isErr()) return err(result.error)
    return ok(actual.equals(result.value))
  })
}

const readContent = (
  content: ApplyContent,
): Promise<Result<Buffer | undefined, ApplyError>> => {
  if (content === undefined) return Promise.resolve(ok(undefined))
  if (Buffer.isBuffer(content)) return Promise.resolve(ok(content))
  return content.read().then((result) => {
    if (result.isErr()) return err(result.error)
    return ok(result.value)
  })
}

export const applyChanges = async (
  changes: readonly ApplyFileChange[],
  store: ApplyStore,
  isPathExcluded: (path: string) => boolean,
): Promise<Result<ApplyOutcome, ApplyError>> => {
  let applied = 0
  let skipped = 0
  const conflicts: ApplyConflict[] = []
  const changesByPath = new Map<string, ApplyFileChange[]>()
  for (const change of changes) {
    const pathChanges = changesByPath.get(change.path) ?? []
    pathChanges.push(change)
    changesByPath.set(change.path, pathChanges)
  }
  const pathCursors = new Map<string, number>()

  for (const change of changes) {
    const pathChanges = changesByPath.get(change.path) ?? []
    const pathCursor = pathCursors.get(change.path) ?? 0
    pathCursors.set(change.path, pathCursor + 1)

    if (isPathExcluded(change.path)) {
      skipped++
      continue
    }

    const currentResult = await ResultAsync.fromPromise(
      store.read(change.path),
      () =>
        new ApplyError('failed to read the current vault file', {
          path: change.path,
          operation: 'read',
        }),
    )
    if (currentResult.isErr()) return err(currentResult.error)
    if (currentResult.value.isErr()) return err(currentResult.value.error)
    const current = currentResult.value.value

    const afterMatch = await equal(current.content, change.after)
    if (afterMatch.isErr()) return err(afterMatch.error)
    if (afterMatch.value) {
      skipped++
      continue
    }
    let alreadyAtLaterState = false
    for (let index = pathCursor + 1; index < pathChanges.length; index++) {
      const laterMatch = await equal(current.content, pathChanges[index]?.after)
      if (laterMatch.isErr()) return err(laterMatch.error)
      if (laterMatch.value) {
        alreadyAtLaterState = true
        break
      }
    }
    if (alreadyAtLaterState) {
      skipped++
      continue
    }
    const beforeMatch = await equal(current.content, change.before)
    if (beforeMatch.isErr()) return err(beforeMatch.error)
    if (!beforeMatch.value) {
      conflicts.push({ commit: change.commit, path: change.path })
      continue
    }

    const revisionResult = await ResultAsync.fromPromise(
      store.readRevision(change.path),
      () =>
        new ApplyError('failed to recheck the vault revision', {
          path: change.path,
          operation: 'revision_check',
        }),
    )
    if (revisionResult.isErr()) return err(revisionResult.error)
    if (revisionResult.value.isErr()) return err(revisionResult.value.error)
    if (revisionResult.value.value !== current.rev) {
      conflicts.push({ commit: change.commit, path: change.path })
      continue
    }

    const contentResult = await readContent(change.after)
    if (contentResult.isErr()) return err(contentResult.error)
    const writeResult =
      contentResult.value === undefined
        ? await ResultAsync.fromPromise(
            store.delete(change.path),
            () =>
              new ApplyError('failed to delete the vault file', {
                path: change.path,
                operation: 'delete',
              }),
          )
        : await ResultAsync.fromPromise(
            store.put(change.path, contentResult.value),
            () =>
              new ApplyError('failed to write the vault file', {
                path: change.path,
                operation: 'write',
              }),
          )
    if (writeResult.isErr()) return err(writeResult.error)
    if (writeResult.value.isErr()) return err(writeResult.value.error)
    applied++
  }

  return ok({ applied, skipped, conflicts })
}
