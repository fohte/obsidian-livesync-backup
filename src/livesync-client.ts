import type { BackupConfig } from '#config'

// eslint-disable-next-line no-restricted-imports -- the generated vendor bundle is external to the app build
import { DirectFileManipulator } from '../vendor-dist/direct-file-manipulator.mjs'

export const createLivesyncClient = (
  config: BackupConfig['couchdb'],
): DirectFileManipulator => {
  const dfm = new DirectFileManipulator({
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
  // $$getReplicator is a stub in CLI usage. Replacing it avoids detached
  // chunk-fetch callbacks throwing when no replica is configured.
  dfm.$$getReplicator = () => undefined
  return dfm
}

export const waitForLivesyncReady = (
  ready: Promise<void>,
  timeoutMs: number,
  createTimeoutError: (timeoutMs: number) => Error,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createTimeoutError(timeoutMs))
    }, timeoutMs)
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
