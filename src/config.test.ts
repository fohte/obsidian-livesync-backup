import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '#config'

const fullEnv = (): Record<string, string> => ({
  COUCHDB_URL: 'http://couchdb.local:5984',
  COUCHDB_USERNAME: 'obsidian-livesync-backup',
  COUCHDB_PASSWORD: 'pw',
  COUCHDB_DATABASE: 'obsidian-v2',
  LIVESYNC_PASSPHRASE: 'phrase',
  GIT_REPOSITORY: 'https://github.com/example/repo.git',
  GIT_BRANCH: 'main',
  GIT_VAULT_SUBDIR: 'src',
  OCTO_STS_URL: 'https://octo-sts.fohte.net',
  OCTO_STS_SCOPE: 'fohte/obsidian-v2',
  OCTO_STS_IDENTITY: 'obsidian-livesync-backup',
  OCTO_STS_SA_TOKEN_PATH: '/var/run/secrets/tokens/octo-sts-token',
  EXCLUDE_PATHS: 'foo/**\nbar/baz',
  EXCLUDE_SECRET_PATTERNS: 'sk-[A-Za-z0-9]+',
})

describe('loadConfig', () => {
  it('parses a complete env into BackupConfig', () => {
    expect(loadConfig(fullEnv())._unsafeUnwrap()).toEqual({
      couchdb: {
        url: 'http://couchdb.local:5984',
        username: 'obsidian-livesync-backup',
        password: 'pw',
        database: 'obsidian-v2',
        passphrase: 'phrase',
        obfuscatePassphrase: 'phrase',
        enableChunkSplitterV2: true,
        enableCompression: false,
        handleFilenameCaseSensitive: false,
      },
      git: {
        repository: 'https://github.com/example/repo.git',
        branch: 'main',
        vaultSubdir: 'src',
      },
      octoSts: {
        url: 'https://octo-sts.fohte.net',
        scope: 'fohte/obsidian-v2',
        identity: 'obsidian-livesync-backup',
        saTokenPath: '/var/run/secrets/tokens/octo-sts-token',
      },
      exclude: {
        paths: ['foo/**', 'bar/baz'],
        secretPatterns: ['sk-[A-Za-z0-9]+'],
      },
    })
  })

  it('defaults optional lists to empty arrays', () => {
    const env = fullEnv()
    delete env['EXCLUDE_PATHS']
    delete env['EXCLUDE_SECRET_PATTERNS']
    const cfg = loadConfig(env)._unsafeUnwrap()
    expect(cfg.exclude).toEqual({ paths: [], secretPatterns: [] })
  })

  it.each([
    'COUCHDB_URL',
    'COUCHDB_USERNAME',
    'COUCHDB_PASSWORD',
    'COUCHDB_DATABASE',
    'LIVESYNC_PASSPHRASE',
    'GIT_REPOSITORY',
    'GIT_BRANCH',
    'GIT_VAULT_SUBDIR',
    'OCTO_STS_URL',
    'OCTO_STS_SCOPE',
    'OCTO_STS_IDENTITY',
    'OCTO_STS_SA_TOKEN_PATH',
  ])('returns a ConfigError when %s is missing', (key) => {
    const env: Record<string, string | undefined> = fullEnv()
    env[key] = undefined
    expect(loadConfig(env)._unsafeUnwrapErr()).toBeInstanceOf(ConfigError)
  })

  it('rejects empty-string values for required keys', () => {
    const env = fullEnv()
    env['COUCHDB_PASSWORD'] = ''
    expect(loadConfig(env)._unsafeUnwrapErr()).toBeInstanceOf(ConfigError)
  })
})
