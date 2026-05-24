import type { BackupConfig } from '@/config'
import { ExcludeFilter } from '@/exclude'
import type { CommitOutcome } from '@/git-backup'
import { makeCommitMessage } from '@/git-backup'
import type { Logger } from '@/logger'
import type { VaultFetcher, VaultFile } from '@/vault-fetcher'

export interface GitBackend {
  clone(): Promise<void>
  syncFiles(files: ReadonlyArray<VaultFile>): Promise<void>
  commitAndPush(message: string): Promise<CommitOutcome>
  cleanup(): void
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

export const runBackup = async (
  config: BackupConfig,
  deps: BackupDependencies,
): Promise<BackupResult> => {
  const { logger, now } = deps
  const snapshotAt = now()
  const filter = new ExcludeFilter(config.exclude)
  const fetcher = deps.fetcherFactory(config)
  const git = deps.gitFactory(config)

  let fetched = 0
  let excluded = 0
  let masked = 0
  const files: VaultFile[] = []

  try {
    logger.info('fetch_start')
    for await (const file of fetcher.fetchAll()) {
      fetched += 1
      if (filter.isPathExcluded(file.path)) {
        excluded += 1
        continue
      }
      const scan = filter.scanContent(file.content)
      if (scan.content === null) {
        excluded += 1
        continue
      }
      if (scan.maskedCount > 0) masked += scan.maskedCount
      files.push({ path: file.path, content: scan.content })
    }
    logger.info('fetch_done', { fetched, excluded, masked })
  } finally {
    await fetcher.close()
  }

  try {
    logger.info('git_clone_start')
    await git.clone()
    await git.syncFiles(files)
    const message = makeCommitMessage({ snapshotAt })
    const outcome = await git.commitAndPush(message)
    logger.info('git_done', {
      written: files.length,
      committed: outcome.committed ? 1 : 0,
    })
    return {
      fetched,
      excluded,
      masked,
      written: files.length,
      committed: outcome.committed,
    }
  } finally {
    git.cleanup()
  }
}
