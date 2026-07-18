export interface BackupConfig {
  couchdb: {
    url: string
    username: string
    password: string
    database: string
    passphrase: string
    obfuscatePassphrase: string
    enableChunkSplitterV2: boolean
    enableCompression: boolean
    handleFilenameCaseSensitive: boolean
  }
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
  exclude: {
    paths: string[]
    secretPatterns: string[]
  }
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

interface EnvSource {
  readonly [key: string]: string | undefined
}

const required = (env: EnvSource, key: string): string => {
  const value = env[key]
  if (value === undefined || value === '') {
    throw new ConfigError(`missing required env: ${key}`)
  }
  return value
}

const optional = (env: EnvSource, key: string, fallback: string): string => {
  const value = env[key]
  if (value === undefined || value === '') return fallback
  return value
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

export const loadConfig = (env: EnvSource = process.env): BackupConfig => {
  const passphrase = required(env, 'LIVESYNC_PASSPHRASE')
  return {
    couchdb: {
      url: required(env, 'COUCHDB_URL'),
      username: required(env, 'COUCHDB_USERNAME'),
      password: required(env, 'COUCHDB_PASSWORD'),
      database: required(env, 'COUCHDB_DATABASE'),
      passphrase,
      // Defaults to the same value as `passphrase`; vaults that configured a
      // distinct path-obfuscation passphrase must set this env explicitly.
      obfuscatePassphrase: optional(
        env,
        'LIVESYNC_OBFUSCATE_PASSPHRASE',
        passphrase,
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
    git: {
      repository: required(env, 'GIT_REPOSITORY'),
      branch: required(env, 'GIT_BRANCH'),
      vaultSubdir: required(env, 'GIT_VAULT_SUBDIR'),
    },
    octoSts: {
      url: required(env, 'OCTO_STS_URL'),
      scope: required(env, 'OCTO_STS_SCOPE'),
      identity: required(env, 'OCTO_STS_IDENTITY'),
      saTokenPath: required(env, 'OCTO_STS_SA_TOKEN_PATH'),
    },
    exclude: {
      paths: optionalList(env, 'EXCLUDE_PATHS'),
      secretPatterns: optionalList(env, 'EXCLUDE_SECRET_PATTERNS'),
    },
  }
}
