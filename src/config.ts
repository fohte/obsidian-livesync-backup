export interface BackupConfig {
  couchdb: {
    url: string
    username: string
    password: string
    database: string
    passphrase: string
  }
  git: {
    repository: string
    branch: string
    vaultSubdir: string
    token: string
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

const optionalList = (env: EnvSource, key: string): string[] => {
  const value = env[key]
  if (value === undefined || value === '') return []
  return value
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export const loadConfig = (env: EnvSource = process.env): BackupConfig => {
  return {
    couchdb: {
      url: required(env, 'COUCHDB_URL'),
      username: required(env, 'COUCHDB_USERNAME'),
      password: required(env, 'COUCHDB_PASSWORD'),
      database: required(env, 'COUCHDB_DATABASE'),
      passphrase: required(env, 'LIVESYNC_PASSPHRASE'),
    },
    git: {
      repository: required(env, 'GIT_REPOSITORY'),
      branch: required(env, 'GIT_BRANCH'),
      vaultSubdir: required(env, 'GIT_VAULT_SUBDIR'),
      token: required(env, 'GIT_TOKEN'),
    },
    exclude: {
      paths: optionalList(env, 'EXCLUDE_PATHS'),
      secretPatterns: optionalList(env, 'EXCLUDE_SECRET_PATTERNS'),
    },
  }
}
