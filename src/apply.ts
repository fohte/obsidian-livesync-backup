import { err, ok, type Result, ResultAsync } from 'neverthrow'

export class ApplyError extends Error {
  override readonly name: string = 'ApplyError'
}

export interface ApplyFileChange {
  readonly commit: string
  readonly path: string
  readonly before: Buffer | undefined
  readonly after: Buffer | undefined
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

const equal = (a: Buffer | undefined, b: Buffer | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b
  return a.equals(b)
}

export const applyChanges = async (
  changes: readonly ApplyFileChange[],
  store: ApplyStore,
  isPathExcluded: (path: string) => boolean,
): Promise<Result<ApplyOutcome, ApplyError>> => {
  let applied = 0
  let skipped = 0
  const conflicts: ApplyConflict[] = []

  for (const change of changes) {
    if (isPathExcluded(change.path)) {
      skipped++
      continue
    }

    const currentResult = await ResultAsync.fromPromise(
      store.read(change.path),
      () => new ApplyError('failed to read the current vault file'),
    )
    if (currentResult.isErr()) return err(currentResult.error)
    if (currentResult.value.isErr()) return err(currentResult.value.error)
    const current = currentResult.value.value

    if (equal(current.content, change.after)) {
      skipped++
      continue
    }
    if (!equal(current.content, change.before)) {
      conflicts.push({ commit: change.commit, path: change.path })
      continue
    }

    const revisionResult = await ResultAsync.fromPromise(
      store.readRevision(change.path),
      () => new ApplyError('failed to recheck the vault revision'),
    )
    if (revisionResult.isErr()) return err(revisionResult.error)
    if (revisionResult.value.isErr()) return err(revisionResult.value.error)
    if (revisionResult.value.value !== current.rev) {
      conflicts.push({ commit: change.commit, path: change.path })
      continue
    }

    const writeResult =
      change.after === undefined
        ? await ResultAsync.fromPromise(
            store.delete(change.path),
            () => new ApplyError('failed to delete the vault file'),
          )
        : await ResultAsync.fromPromise(
            store.put(change.path, change.after),
            () => new ApplyError('failed to write the vault file'),
          )
    if (writeResult.isErr()) return err(writeResult.error)
    if (writeResult.value.isErr()) return err(writeResult.value.error)
    applied++
  }

  return ok({ applied, skipped, conflicts })
}
