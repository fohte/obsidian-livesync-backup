import { resolve } from 'node:path'

import { err, ok, Result } from 'neverthrow'

import { applyChanges, ApplyError } from '#apply'
import { loadApplyChanges } from '#apply-git'
import { LivesyncApplyStore } from '#apply-vault'
import { loadApplyConfig } from '#config'
import { ExcludeFilter } from '#exclude'
import { SafeLogger } from '#logger'

interface ApplyArguments {
  readonly checkoutPath: string
  readonly from: string
  readonly to: string
  readonly vaultDir: string
  readonly excludedAuthorEmail: string
}

const parseArguments = (
  args: readonly string[],
): Result<ApplyArguments, ApplyError> => {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (
      key === undefined ||
      value === undefined ||
      !key.startsWith('--') ||
      values.has(key)
    ) {
      return err(new ApplyError('invalid apply arguments'))
    }
    values.set(key, value)
  }

  const checkoutPath = values.get('--checkout-path')
  const from = values.get('--from')
  const to = values.get('--to')
  const vaultDir = values.get('--vault-dir')
  const excludedAuthorEmail = values.get('--exclude-author-email')
  const allowed = new Set([
    '--checkout-path',
    '--from',
    '--to',
    '--vault-dir',
    '--exclude-author-email',
  ])
  if (
    [...values.keys()].some((key) => !allowed.has(key)) ||
    checkoutPath === undefined ||
    checkoutPath.length === 0 ||
    from === undefined ||
    from.length === 0 ||
    to === undefined ||
    to.length === 0 ||
    vaultDir === undefined ||
    vaultDir.length === 0 ||
    excludedAuthorEmail === undefined ||
    excludedAuthorEmail.length === 0
  ) {
    return err(new ApplyError('invalid apply arguments'))
  }
  return ok({
    checkoutPath: resolve(checkoutPath),
    from,
    to,
    vaultDir,
    excludedAuthorEmail,
  })
}

export const runApply = async (args: readonly string[]): Promise<number> => {
  const logger = new SafeLogger()
  const argsResult = parseArguments(args)
  if (argsResult.isErr()) {
    logger.error('apply_invalid_arguments', { kind: 'arguments' })
    return 2
  }

  const configResult = loadApplyConfig()
  if (configResult.isErr()) {
    logger.error('apply_config_invalid', { kind: 'config' })
    return 2
  }

  const changesResult = await loadApplyChanges({
    checkoutPath: argsResult.value.checkoutPath,
    from: argsResult.value.from,
    to: argsResult.value.to,
    vaultDir: argsResult.value.vaultDir,
    excludedAuthorEmail: argsResult.value.excludedAuthorEmail,
  })
  if (changesResult.isErr()) {
    logger.error('apply_git_failed', { kind: 'git' })
    return 2
  }

  const filterResult = Result.fromThrowable(
    () => new ExcludeFilter(configResult.value.exclude),
    () => new ApplyError('invalid exclude configuration'),
  )()
  if (filterResult.isErr()) {
    logger.error('apply_config_invalid', { kind: 'exclude' })
    return 2
  }

  const storeResult = Result.fromThrowable(
    () => new LivesyncApplyStore(configResult.value.couchdb),
    () => new ApplyError('failed to initialize LiveSync connection'),
  )()
  if (storeResult.isErr()) {
    logger.error('apply_connection_failed', { kind: 'connection' })
    return 2
  }
  const store = storeResult.value

  const outcomeResult = await applyChanges(changesResult.value, store, (path) =>
    filterResult.value.isPathExcluded(path),
  )
  const closeResult = await store.close()
  if (outcomeResult.isErr() || closeResult.isErr()) {
    logger.error('apply_failed', { kind: 'connection' })
    return 2
  }

  const outcome = outcomeResult.value
  for (const conflict of outcome.conflicts) {
    logger.warn('apply_conflict', {
      path: conflict.path,
      commit: conflict.commit,
    })
  }
  logger.info('apply_done', {
    applied: outcome.applied,
    skipped: outcome.skipped,
    conflicts: outcome.conflicts.length,
  })
  return outcome.conflicts.length > 0 ? 1 : 0
}
