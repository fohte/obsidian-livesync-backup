import { ok, type Result } from 'neverthrow'
import { beforeEach, describe, expect, it } from 'vitest'

import { type GitBackend, runBackup } from '#backup'
import type { BackupConfig } from '#config'
import type { CommitOutcome, GitOperationError } from '#git-backup'
import type { Logger, LogLevel } from '#logger'
import { SafeLogger } from '#logger'
import type { VaultFetcher, VaultFile } from '#vault-fetcher'

const baseConfig = (): BackupConfig => ({
  couchdb: {
    url: 'http://couchdb:5984',
    username: 'u',
    password: 'pw-SECRET',
    database: 'obsidian-v2',
    passphrase: 'phrase-SECRET',
    obfuscatePassphrase: 'phrase-SECRET',
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
    scope: 'fohte/repo',
    identity: 'obsidian-livesync-backup',
    saTokenPath: '/var/run/secrets/tokens/octo-sts-token',
  },
  exclude: {
    paths: [],
    secretPatterns: ['ghp_[A-Za-z0-9]+'],
  },
})

const text = (path: string, body: string): VaultFile => ({
  path,
  content: { kind: 'text', text: body },
})

const binary = (path: string, bytes: Buffer): VaultFile => ({
  path,
  content: { kind: 'binary', bytes },
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
  syncStarted = false
  synced: VaultFile[] = []
  commitMessages: string[] = []
  cleanedUp = false
  constructor(public commitOutcome = true) {}
  async clone(): Promise<Result<void, GitOperationError>> {
    this.cloned = true
    return ok(undefined)
  }
  async beginVaultSync(): Promise<Result<void, GitOperationError>> {
    this.syncStarted = true
    return ok(undefined)
  }
  async writeFile(file: VaultFile): Promise<Result<void, GitOperationError>> {
    this.synced.push(file)
    return ok(undefined)
  }
  async commitAndPush(
    message: string,
  ): Promise<Result<CommitOutcome, GitOperationError>> {
    this.commitMessages.push(message)
    return ok({ committed: this.commitOutcome })
  }
  cleanup(): Result<void, GitOperationError> {
    this.cleanedUp = true
    return ok(undefined)
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
      text('notes/inbox.md', 'note body'),
      text('.obsidian/plugins/obsidian-livesync/data.json', '{}'),
      text('.trash/old.md', 'trash'),
      text('tmp/draft.tmp', 'tmp'),
      text('.obsidian/app.json', '{"a":1}'),
    ])
    const git = new StubGit(true)
    const result = (
      await runBackup(config, {
        fetcherFactory: () => fetcher,
        gitFactory: () => git,
        logger: new RecordingLogger(),
        now: () => new Date('2026-05-24T15:00:00Z'),
      })
    )._unsafeUnwrap()
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
      fetcherFactory: () => new StubFetcher([text('a.md', 'x')]),
      gitFactory: () => git,
      logger: new RecordingLogger(),
      now: () => new Date('2026-05-24T15:00:00Z'),
    })
    expect(git.commitMessages).toHaveLength(1)
    expect(git.commitMessages[0]).toContain('2026-05-25T00:00:00+09:00')
  })

  it('does not commit when no diff', async () => {
    const git = new StubGit(false)
    const result = (
      await runBackup(config, {
        fetcherFactory: () => new StubFetcher([text('a.md', 'x')]),
        gitFactory: () => git,
        logger: new RecordingLogger(),
        now: () => new Date('2026-05-24T15:00:00Z'),
      })
    )._unsafeUnwrap()
    expect(result.committed).toBe(false)
  })

  it('masks secret patterns in text content', async () => {
    const git = new StubGit(true)
    const result = (
      await runBackup(config, {
        fetcherFactory: () =>
          new StubFetcher([text('a.md', 'ghp_abc123 normal')]),
        gitFactory: () => git,
        logger: new RecordingLogger(),
        now: () => new Date('2026-05-24T15:00:00Z'),
      })
    )._unsafeUnwrap()
    expect(result.masked).toBe(1)
    const synced = git.synced[0]
    expect(synced?.content).toEqual({
      kind: 'text',
      text: '***REDACTED*** normal',
    })
  })

  it('preserves binary content unchanged and skips content scan', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])
    const git = new StubGit(true)
    const result = (
      await runBackup(config, {
        fetcherFactory: () =>
          new StubFetcher([binary('attachments/photo.jpg', bytes)]),
        gitFactory: () => git,
        logger: new RecordingLogger(),
        now: () => new Date('2026-05-24T15:00:00Z'),
      })
    )._unsafeUnwrap()
    expect(result.masked).toBe(0)
    const synced = git.synced[0]
    expect(synced?.content).toEqual({
      kind: 'binary',
      bytes,
    })
  })

  it('cleans up the git backend even when fetching fails', async () => {
    class FailingFetcher implements VaultFetcher {
      async *fetchAll(): AsyncIterable<VaultFile> {
        throw new Error('couchdb unreachable')
      }
      async close(): Promise<void> {}
    }
    const git = new StubGit(true)
    const result = await runBackup(config, {
      fetcherFactory: () => new FailingFetcher(),
      gitFactory: () => git,
      logger: new RecordingLogger(),
      now: () => new Date('2026-05-24T15:00:00Z'),
    })
    expect(result.isErr()).toBe(true)
    expect(git.cleanedUp).toBe(true)
  })

  it('does not leak vault content, filenames, or credentials to logs', async () => {
    const logger = new RecordingLogger()
    const git = new StubGit(true)
    const sensitiveContent = 'TOP-SECRET-CONTENT ghp_abc123'
    const sensitivePath = 'notes/SECRET-NAME.md'
    await runBackup(config, {
      fetcherFactory: () =>
        new StubFetcher([text(sensitivePath, sensitiveContent)]),
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
  })
})
