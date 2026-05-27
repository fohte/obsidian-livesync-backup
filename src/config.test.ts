import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '@/config'

const fullEnv = (): Record<string, string> => ({
  COUCHDB_URL: 'http://couchdb.local:5984',
  COUCHDB_USERNAME: 'obsidian-livesync-backup',
  COUCHDB_PASSWORD: 'pw',
  COUCHDB_DATABASE: 'obsidian-v2',
  LIVESYNC_PASSPHRASE: 'phrase',
  GIT_REPOSITORY: 'https://github.com/example/repo.git',
  GIT_BRANCH: 'main',
  GIT_VAULT_SUBDIR: 'src',
  GIT_TOKEN: 'pat',
  EXCLUDE_PATHS: 'foo/**\nbar/baz',
  EXCLUDE_SECRET_PATTERNS: 'sk-[A-Za-z0-9]+',
})

describe('loadConfig', () => {
  it('parses a complete env into BackupConfig', () => {
    const cfg = loadConfig(fullEnv())
    expect(cfg.couchdb.url).toBe('http://couchdb.local:5984')
    expect(cfg.git.vaultSubdir).toBe('src')
    expect(cfg.exclude.paths).toEqual(['foo/**', 'bar/baz'])
    expect(cfg.exclude.secretPatterns).toEqual(['sk-[A-Za-z0-9]+'])
  })

  it('defaults optional lists to empty arrays', () => {
    const env = fullEnv()
    delete env['EXCLUDE_PATHS']
    delete env['EXCLUDE_SECRET_PATTERNS']
    const cfg = loadConfig(env)
    expect(cfg.exclude.paths).toEqual([])
    expect(cfg.exclude.secretPatterns).toEqual([])
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
    'GIT_TOKEN',
  ])('throws ConfigError when %s is missing', (key) => {
    const env: Record<string, string | undefined> = fullEnv()
    env[key] = undefined
    expect(() => loadConfig(env)).toThrow(ConfigError)
  })

  it('rejects empty-string values for required keys', () => {
    const env = fullEnv()
    env['COUCHDB_PASSWORD'] = ''
    expect(() => loadConfig(env)).toThrow(ConfigError)
  })
})
