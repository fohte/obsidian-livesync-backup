import { runBackup } from '@/backup'
import { ConfigError, loadConfig } from '@/config'
import { GitBackup } from '@/git-backup'
import { SafeLogger } from '@/logger'
import { LivesyncVaultFetcher } from '@/vault-fetcher'

const main = async (): Promise<number> => {
  const logger = new SafeLogger()
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error('config_invalid', { kind: 'config' })
    } else {
      logger.error('config_invalid', { kind: 'unknown' })
    }
    return 2
  }

  try {
    await runBackup(config, {
      fetcherFactory: (c) => new LivesyncVaultFetcher(c.couchdb),
      gitFactory: (c) => new GitBackup(c.git),
      logger,
      now: () => new Date(),
    })
    return 0
  } catch (err) {
    const kind = classifyError(err)
    logger.error('backup_failed', { kind })
    return 1
  }
}

const classifyError = (err: unknown): string => {
  if (!(err instanceof Error)) return 'unknown'
  const name = err.name
  if (/^[a-z][a-z0-9_]*$/i.test(name) && name.length <= 32) {
    return name.toLowerCase()
  }
  return 'error'
}

const exitCode = await main()
process.exit(exitCode)
