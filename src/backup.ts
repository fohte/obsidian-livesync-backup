import { err, ok, Result, ResultAsync } from 'neverthrow'

import type { BackupConfig } from '#config'
import { BoundaryError } from '#errors'
import { ExcludeFilter } from '#exclude'
import type { CommitOutcome, GitOperationError } from '#git-backup'
import { makeCommitMessage } from '#git-backup'
import type { Logger } from '#logger'
import type { VaultFetcher, VaultFile } from '#vault-fetcher'

export interface GitBackend {
  clone(): Promise<Result<void, GitOperationError>>
  beginVaultSync(): Promise<Result<void, GitOperationError>>
  writeFile(file: VaultFile): Promise<Result<void, GitOperationError>>
  commitAndPush(
    message: string,
  ): Promise<Result<CommitOutcome, GitOperationError>>
  cleanup(): Result<void, GitOperationError>
}

export interface BackupDependencies {
  readonly fetcherFactory: (config: BackupConfig) => VaultFetcher
  readonly gitFactory: (config: BackupConfig) => GitBackend
  readonly logger: Logger
  readonly now: () => Date
}

export interface BackupResult {
  readonly fetched: number
  readonly excluded: number
  readonly masked: number
  readonly written: number
  readonly committed: boolean
}

// The VaultFetcher contract is a throwing async iterable (a PouchDB-backed
// third-party client), not a Result — wrap its rejection at this boundary.
export class VaultFetchError extends BoundaryError {}

type FetchedCounts = Omit<BackupResult, 'committed'>

const closeFetcherSafely = async (
  fetcher: VaultFetcher,
  logger: Logger,
): Promise<void> => {
  const result = await ResultAsync.fromPromise(
    fetcher.close(),
    (cause) => cause,
  )
  if (result.isErr()) {
    // Closing failures must not mask the primary backup error.
    logger.warn('fetcher_close_failed', { kind: 'close' })
  }
}

const cleanupGitSafely = (git: GitBackend, logger: Logger): void => {
  const result = git.cleanup()
  if (result.isErr()) {
    logger.warn('git_cleanup_failed', { kind: 'cleanup' })
  }
}

const fetchAndWriteAll = async (
  fetcher: VaultFetcher,
  git: GitBackend,
  filter: ExcludeFilter,
): Promise<Result<FetchedCounts, VaultFetchError | GitOperationError>> => {
  const iterate = async (): Promise<
    Result<FetchedCounts, GitOperationError>
  > => {
    let fetched = 0
    let excluded = 0
    let masked = 0
    let written = 0
    for await (const file of fetcher.fetchAll()) {
      fetched += 1
      if (filter.isPathExcluded(file.path)) {
        excluded += 1
        continue
      }
      let toWrite: VaultFile = file
      if (file.content.kind === 'text') {
        const scan = filter.scanContent(file.content.text)
        masked += scan.maskedCount
        toWrite = {
          path: file.path,
          content: { kind: 'text', text: scan.content },
        }
      }
      const writeResult = await git.writeFile(toWrite)
      if (writeResult.isErr()) return err(writeResult.error)
      written += 1
    }
    return ok({ fetched, excluded, masked, written })
  }

  return ResultAsync.fromPromise(
    iterate(),
    (cause) => new VaultFetchError('failed to fetch vault files', cause),
  ).andThen((inner) => inner)
}

const performBackup = async (
  config: BackupConfig,
  deps: BackupDependencies,
  git: GitBackend,
  filter: ExcludeFilter,
  snapshotAt: Date,
): Promise<Result<BackupResult, VaultFetchError | GitOperationError>> => {
  const { logger } = deps

  logger.info('git_clone_start')
  const cloneResult = await git.clone()
  if (cloneResult.isErr()) return err(cloneResult.error)

  const beginResult = await git.beginVaultSync()
  if (beginResult.isErr()) return err(beginResult.error)

  // deps.fetcherFactory constructs a third-party client (e.g. LivesyncVaultFetcher
  // wraps DirectFileManipulator) that may throw synchronously — wrap it so a
  // construction failure still returns a Result instead of skipping cleanup below.
  const fetcherResult = Result.fromThrowable(
    () => deps.fetcherFactory(config),
    (cause) => new VaultFetchError('failed to construct vault fetcher', cause),
  )()
  if (fetcherResult.isErr()) return err(fetcherResult.error)
  const fetcher = fetcherResult.value
  logger.info('fetch_start')
  const fetchResult = await fetchAndWriteAll(fetcher, git, filter)
  await closeFetcherSafely(fetcher, logger)
  if (fetchResult.isErr()) return err(fetchResult.error)
  const { fetched, excluded, masked, written } = fetchResult.value
  logger.info('fetch_done', { fetched, excluded, masked, written })

  const commitResult = await git.commitAndPush(
    makeCommitMessage({ snapshotAt }),
  )
  if (commitResult.isErr()) return err(commitResult.error)
  const outcome = commitResult.value
  logger.info('git_done', {
    written,
    committed: outcome.committed ? 1 : 0,
  })
  return ok({
    fetched,
    excluded,
    masked,
    written,
    committed: outcome.committed,
  })
}

export const runBackup = async (
  config: BackupConfig,
  deps: BackupDependencies,
): Promise<Result<BackupResult, VaultFetchError | GitOperationError>> => {
  const { logger, now } = deps
  const snapshotAt = now()
  const filter = new ExcludeFilter(config.exclude)
  const git = deps.gitFactory(config)

  const result = await performBackup(config, deps, git, filter, snapshotAt)
  cleanupGitSafely(git, logger)
  return result
}
