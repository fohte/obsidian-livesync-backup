import type { CouchDbConfig, ExcludeConfig } from 'livesync/config'
import { err, ok, type Result } from 'neverthrow'

export interface BackupConfig {
  couchdb: CouchDbConfig
  git: {
    repository: string
    branch: string
    vaultSubdir: string
  }
  octoSts: {
    url: string
    scope: string
    identity: string
    saTokenPath: string
  }
  exclude: ExcludeConfig
}

export interface ApplyConfig {
  couchdb: CouchDbConfig
  exclude: ExcludeConfig
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

interface EnvSource {
  readonly [key: string]: string | undefined
}

const required = (env: EnvSource, key: string): Result<string, ConfigError> => {
  const value = env[key]
  if (value === undefined || value === '') {
    return err(new ConfigError(`missing required env: ${key}`))
  }
  return ok(value)
}

const optionalPassphrase = (
  env: EnvSource,
  key: string,
  fallback: string,
): string | undefined => {
  const value = env[key]
  if (value === undefined) return fallback
  return value === '' ? undefined : value
}

const optionalBool = (
  env: EnvSource,
  key: string,
  fallback: boolean,
): boolean => {
  const value = env[key]
  if (value === undefined || value === '') return fallback
  return value === 'true' || value === '1'
}

const optionalList = (env: EnvSource, key: string): string[] => {
  const value = env[key]
  if (value === undefined || value === '') return []
  return value
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export const loadConfig = (
  env: EnvSource = process.env,
): Result<BackupConfig, ConfigError> => {
  const applyConfig = loadApplyConfig(env)
  if (applyConfig.isErr()) return err(applyConfig.error)

  const gitRepository = required(env, 'GIT_REPOSITORY')
  if (gitRepository.isErr()) return err(gitRepository.error)
  const gitBranch = required(env, 'GIT_BRANCH')
  if (gitBranch.isErr()) return err(gitBranch.error)
  const gitVaultSubdir = required(env, 'GIT_VAULT_SUBDIR')
  if (gitVaultSubdir.isErr()) return err(gitVaultSubdir.error)
  const octoStsUrl = required(env, 'OCTO_STS_URL')
  if (octoStsUrl.isErr()) return err(octoStsUrl.error)
  const octoStsScope = required(env, 'OCTO_STS_SCOPE')
  if (octoStsScope.isErr()) return err(octoStsScope.error)
  const octoStsIdentity = required(env, 'OCTO_STS_IDENTITY')
  if (octoStsIdentity.isErr()) return err(octoStsIdentity.error)
  const octoStsSaTokenPath = required(env, 'OCTO_STS_SA_TOKEN_PATH')
  if (octoStsSaTokenPath.isErr()) return err(octoStsSaTokenPath.error)

  return ok({
    ...applyConfig.value,
    git: {
      repository: gitRepository.value,
      branch: gitBranch.value,
      vaultSubdir: gitVaultSubdir.value,
    },
    octoSts: {
      url: octoStsUrl.value,
      scope: octoStsScope.value,
      identity: octoStsIdentity.value,
      saTokenPath: octoStsSaTokenPath.value,
    },
  })
}

export const loadApplyConfig = (
  env: EnvSource = process.env,
): Result<ApplyConfig, ConfigError> => {
  const couchdbUrl = required(env, 'COUCHDB_URL')
  if (couchdbUrl.isErr()) return err(couchdbUrl.error)
  const couchdbUsername = required(env, 'COUCHDB_USERNAME')
  if (couchdbUsername.isErr()) return err(couchdbUsername.error)
  const couchdbPassword = required(env, 'COUCHDB_PASSWORD')
  if (couchdbPassword.isErr()) return err(couchdbPassword.error)
  const couchdbDatabase = required(env, 'COUCHDB_DATABASE')
  if (couchdbDatabase.isErr()) return err(couchdbDatabase.error)
  const passphrase = required(env, 'LIVESYNC_PASSPHRASE')
  if (passphrase.isErr()) return err(passphrase.error)
  return ok({
    couchdb: {
      url: couchdbUrl.value,
      username: couchdbUsername.value,
      password: couchdbPassword.value,
      database: couchdbDatabase.value,
      passphrase: passphrase.value,
      // Defaults to `passphrase`; an empty value disables path obfuscation.
      obfuscatePassphrase: optionalPassphrase(
        env,
        'LIVESYNC_OBFUSCATE_PASSPHRASE',
        passphrase.value,
      ),
      enableChunkSplitterV2: optionalBool(
        env,
        'LIVESYNC_CHUNK_SPLITTER_V2',
        true,
      ),
      enableCompression: optionalBool(env, 'LIVESYNC_COMPRESSION', false),
      handleFilenameCaseSensitive: optionalBool(
        env,
        'LIVESYNC_FILENAME_CASE_SENSITIVE',
        false,
      ),
    },
    exclude: {
      paths: optionalList(env, 'EXCLUDE_PATHS'),
      secretPatterns: optionalList(env, 'EXCLUDE_SECRET_PATTERNS'),
    },
  })
}
