import { beforeEach, describe, expect, it } from 'vitest'

import { type GitBackend, runBackup } from '@/backup'
import type { BackupConfig } from '@/config'
import type { Logger, LogLevel } from '@/logger'
import { SafeLogger } from '@/logger'
import type { VaultFetcher, VaultFile } from '@/vault-fetcher'

const baseConfig = (): BackupConfig => ({
  couchdb: {
    url: 'http://couchdb:5984',
    username: 'u',
    password: 'pw-SECRET',
    database: 'obsidian-v2',
    passphrase: 'phrase-SECRET',
  },
  git: {
    repository: 'https://github.com/example/repo.git',
    branch: 'main',
    vaultSubdir: 'src',
    token: 'ghp_SECRET',
  },
  exclude: {
    paths: [],
    secretPatterns: ['ghp_[A-Za-z0-9]+'],
  },
})

class StubFetcher implements VaultFetcher {
  constructor(private readonly files: VaultFile[]) {}
  async *fetchAll(): AsyncIterable<VaultFile> {
    for (const f of this.files) yield f
  }
  async close(): Promise<void> {}
}

class StubGit implements GitBackend {
  cloned = false
  synced: ReadonlyArray<VaultFile> = []
  commitMessages: string[] = []
  cleanedUp = false
  constructor(public commitOutcome = true) {}
  async clone(): Promise<void> {
    this.cloned = true
  }
  async syncFiles(files: ReadonlyArray<VaultFile>): Promise<void> {
    this.synced = files
  }
  async commitAndPush(message: string): Promise<{ committed: boolean }> {
    this.commitMessages.push(message)
    return { committed: this.commitOutcome }
  }
  cleanup(): void {
    this.cleanedUp = true
  }
}

class RecordingLogger implements Logger {
  readonly lines: string[] = []
  private readonly inner = new SafeLogger({
    write: (l) => this.lines.push(l),
  })
  log(
    level: LogLevel,
    event: string,
    fields?: Readonly<Record<string, number | string>>,
  ): void {
    this.inner.log(level, event, fields)
  }
  info(
    event: string,
    fields?: Readonly<Record<string, number | string>>,
  ): void {
    this.inner.info(event, fields)
  }
  warn(
    event: string,
    fields?: Readonly<Record<string, number | string>>,
  ): void {
    this.inner.warn(event, fields)
  }
  error(
    event: string,
    fields?: Readonly<Record<string, number | string>>,
  ): void {
    this.inner.error(event, fields)
  }
}

describe('runBackup', () => {
  let config: BackupConfig
  beforeEach(() => {
    config = baseConfig()
  })

  it('excludes default paths and writes the rest', async () => {
    const fetcher = new StubFetcher([
      { path: 'notes/inbox.md', content: 'note body' },
      { path: '.obsidian/plugins/obsidian-livesync/data.json', content: '{}' },
      { path: '.trash/old.md', content: 'trash' },
      { path: 'tmp/draft.tmp', content: 'tmp' },
      { path: '.obsidian/app.json', content: '{"a":1}' },
    ])
    const git = new StubGit(true)
    const result = await runBackup(config, {
      fetcherFactory: () => fetcher,
      gitFactory: () => git,
      logger: new RecordingLogger(),
      now: () => new Date('2026-05-24T15:00:00Z'),
    })
    expect(result.fetched).toBe(5)
    expect(result.excluded).toBe(3)
    expect(result.written).toBe(2)
    expect(git.synced.map((f) => f.path).sort()).toEqual([
      '.obsidian/app.json',
      'notes/inbox.md',
    ])
  })

  it('produces a commit message with snapshot time in JST ISO 8601', async () => {
    const git = new StubGit(true)
    await runBackup(config, {
      fetcherFactory: () => new StubFetcher([{ path: 'a.md', content: 'x' }]),
      gitFactory: () => git,
      logger: new RecordingLogger(),
      now: () => new Date('2026-05-24T15:00:00Z'),
    })
    expect(git.commitMessages).toHaveLength(1)
    expect(git.commitMessages[0]).toContain('2026-05-25T00:00:00+09:00')
  })

  it('does not commit when no diff', async () => {
    const git = new StubGit(false)
    const result = await runBackup(config, {
      fetcherFactory: () => new StubFetcher([{ path: 'a.md', content: 'x' }]),
      gitFactory: () => git,
      logger: new RecordingLogger(),
      now: () => new Date('2026-05-24T15:00:00Z'),
    })
    expect(result.committed).toBe(false)
  })

  it('masks secrets that match patterns', async () => {
    const git = new StubGit(true)
    const result = await runBackup(config, {
      fetcherFactory: () =>
        new StubFetcher([{ path: 'a.md', content: 'ghp_abc123 normal' }]),
      gitFactory: () => git,
      logger: new RecordingLogger(),
      now: () => new Date('2026-05-24T15:00:00Z'),
    })
    expect(result.masked).toBe(1)
    expect(git.synced[0]?.content).toBe('***REDACTED*** normal')
  })

  it('does not leak vault content, filenames, or credentials to logs', async () => {
    const logger = new RecordingLogger()
    const git = new StubGit(true)
    const sensitiveContent = 'TOP-SECRET-CONTENT ghp_abc123'
    const sensitivePath = 'notes/SECRET-NAME.md'
    await runBackup(config, {
      fetcherFactory: () =>
        new StubFetcher([{ path: sensitivePath, content: sensitiveContent }]),
      gitFactory: () => git,
      logger,
      now: () => new Date('2026-05-24T15:00:00Z'),
    })
    const joined = logger.lines.join('\n')
    expect(joined).not.toContain(sensitiveContent)
    expect(joined).not.toContain(sensitivePath)
    expect(joined).not.toContain('SECRET-NAME')
    expect(joined).not.toContain(config.couchdb.password)
    expect(joined).not.toContain(config.couchdb.passphrase)
    expect(joined).not.toContain(config.git.token)
  })
})
