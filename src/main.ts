import { exchangeOctoStsToken } from '#auth/octo-sts'
import { runBackup } from '#backup'
import { loadConfig } from '#config'
import { GitBackup } from '#git-backup'
import { SafeLogger } from '#logger'
import { LivesyncVaultFetcher, MissingChunkError } from '#vault-fetcher'

const main = async (): Promise<number> => {
  const logger = new SafeLogger()

  const configResult = loadConfig()
  if (configResult.isErr()) {
    logger.error('config_invalid', { kind: 'config' })
    return 2
  }
  const config = configResult.value

  const tokenResult = await exchangeOctoStsToken(config.octoSts)
  if (tokenResult.isErr()) {
    logger.error('octo_sts_auth_failed', {
      kind: classifyError(tokenResult.error),
    })
    return 2
  }
  const gitToken = tokenResult.value

  const backupResult = await runBackup(config, {
    fetcherFactory: (c) => new LivesyncVaultFetcher(c.couchdb),
    gitFactory: (c) => new GitBackup({ ...c.git, token: gitToken }),
    logger,
    now: () => new Date(),
  })
  if (backupResult.isErr()) {
    const error = backupResult.error
    const missingChunk =
      error.cause instanceof MissingChunkError ? error.cause : undefined
    const fields: Record<string, number | string> = {
      kind: classifyError(error, missingChunk),
    }
    if (missingChunk) {
      fields['path'] = missingChunk.path
    }
    logger.error('backup_failed', fields)
    return 1
  }
  return 0
}

const classifyError = (
  err: unknown,
  missingChunk?: MissingChunkError,
): string => {
  if (!(err instanceof Error)) return 'unknown'
  const name = missingChunk?.name ?? err.name
  if (/^[a-z][a-z0-9_]*$/i.test(name) && name.length <= 32) {
    return name.toLowerCase()
  }
  return 'error'
}

const exitCode = await main()
process.exit(exitCode)
