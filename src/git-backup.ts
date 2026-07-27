import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'

import { err, ok, Result, ResultAsync } from 'neverthrow'
import { type SimpleGit, simpleGit } from 'simple-git'

import type { VaultFile } from '#vault-fetcher'

export class GitOperationError extends Error {
  override readonly name = 'GitOperationError'
  constructor(public readonly operation: string) {
    super(`git operation failed: ${operation}`)
  }
}

const runGit = async <T>(
  operation: string,
  fn: () => Promise<T>,
): Promise<Result<T, GitOperationError>> =>
  // Discard the original error: simple-git surfaces the command line, which
  // includes the embedded `x-access-token:<PAT>` for clone and push.
  ResultAsync.fromPromise(fn(), () => new GitOperationError(operation))

const trySync = <T>(
  operation: string,
  fn: () => T,
): Result<T, GitOperationError> =>
  Result.fromThrowable(fn, () => new GitOperationError(operation))()

export interface GitBackupConfig {
  readonly repository: string
  readonly branch: string
  readonly vaultSubdir: string
  readonly token: string
}

export interface CommitOutcome {
  readonly committed: boolean
}

const COMMIT_AUTHOR_NAME = 'obsidian-livesync-backup'
const COMMIT_AUTHOR_EMAIL = 'obsidian-livesync-backup@users.noreply.github.com'

const authedRepoUrl = (repository: string, token: string): string => {
  const url = new URL(repository)
  url.username = 'x-access-token'
  url.password = token
  return url.toString()
}

const isPathInside = (parent: string, child: string): boolean => {
  const p = resolve(parent)
  const c = resolve(child)
  return c === p || c.startsWith(`${p}/`)
}

const removeAllFiles = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    rmSync(join(dir, entry.name), { recursive: true, force: true })
  }
}

export interface MakeCommitMessageInput {
  readonly snapshotAt: Date
}

export const makeCommitMessage = ({
  snapshotAt,
}: MakeCommitMessageInput): string => {
  const iso = formatJstIso8601(snapshotAt)
  return `chore(backup): snapshot at ${iso}`
}

const formatJstIso8601 = (date: Date): string => {
  // JST = UTC+9, no DST
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  const y = jst.getUTCFullYear().toString().padStart(4, '0')
  const m = (jst.getUTCMonth() + 1).toString().padStart(2, '0')
  const d = jst.getUTCDate().toString().padStart(2, '0')
  const hh = jst.getUTCHours().toString().padStart(2, '0')
  const mm = jst.getUTCMinutes().toString().padStart(2, '0')
  const ss = jst.getUTCSeconds().toString().padStart(2, '0')
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}+09:00`
}

export class GitBackup {
  private readonly cloneDir: string
  private readonly git: SimpleGit

  constructor(private readonly config: GitBackupConfig) {
    this.cloneDir = mkdtempSync(join(tmpdir(), 'olbb-clone-'))
    this.git = simpleGit(this.cloneDir)
  }

  async clone(): Promise<Result<void, GitOperationError>> {
    const urlResult = trySync('clone', () =>
      authedRepoUrl(this.config.repository, this.config.token),
    )
    if (urlResult.isErr()) return err(urlResult.error)

    const cloneResult = await runGit('clone', () =>
      this.git.clone(urlResult.value, this.cloneDir, [
        '--depth=1',
        '--branch',
        this.config.branch,
        '--single-branch',
      ]),
    )
    if (cloneResult.isErr()) return err(cloneResult.error)

    return runGit('config', async () => {
      await this.git.addConfig('user.name', COMMIT_AUTHOR_NAME)
      await this.git.addConfig('user.email', COMMIT_AUTHOR_EMAIL)
    })
  }

  /**
   * Empties the vault subdir so that subsequent {@link writeFile} calls can
   * write the new vault state and `git add -A` will pick up deletions.
   */
  async beginVaultSync(): Promise<Result<void, GitOperationError>> {
    const vaultRoot = join(this.cloneDir, this.config.vaultSubdir)
    if (!isPathInside(this.cloneDir, vaultRoot)) {
      return err(new GitOperationError('beginVaultSync'))
    }
    const mkdirResult = await runGit('beginVaultSync', () =>
      mkdir(vaultRoot, { recursive: true }),
    )
    if (mkdirResult.isErr()) return err(mkdirResult.error)
    return trySync('beginVaultSync', () => {
      removeAllFiles(vaultRoot)
    })
  }

  async writeFile(file: VaultFile): Promise<Result<void, GitOperationError>> {
    const vaultRoot = join(this.cloneDir, this.config.vaultSubdir)
    const normalized = posix.normalize(file.path).replace(/^\/+/, '')
    if (normalized.startsWith('../') || normalized.includes('/../')) {
      return err(new GitOperationError('writeFile'))
    }
    const dest = join(vaultRoot, normalized)
    if (!isPathInside(vaultRoot, dest)) {
      return err(new GitOperationError('writeFile'))
    }
    const mkdirResult = await runGit('writeFile', () =>
      mkdir(dirname(dest), { recursive: true }),
    )
    if (mkdirResult.isErr()) return err(mkdirResult.error)

    if (file.content.kind === 'text') {
      const text = file.content.text
      return trySync('writeFile', () => {
        writeFileSync(dest, text)
      })
    }
    // @types/node's Buffer is Uint8Array<ArrayBufferLike>, which doesn't
    // satisfy writeFileSync's `Uint8Array<ArrayBuffer>` under strictest
    // typing. Take a same-memory view as Uint8Array<ArrayBuffer> so the
    // call is correctly typed without copying.
    const buffer = file.content.bytes
    return trySync('writeFile', () => {
      writeFileSync(
        dest,
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      )
    })
  }

  async commitAndPush(
    message: string,
  ): Promise<Result<CommitOutcome, GitOperationError>> {
    const addResult = await runGit('add', () =>
      this.git.add(['-A', this.config.vaultSubdir]),
    )
    if (addResult.isErr()) return err(addResult.error)

    const statusResult = await runGit('status', () => this.git.status())
    if (statusResult.isErr()) return err(statusResult.error)
    if (statusResult.value.files.length === 0) {
      return ok({ committed: false })
    }

    const commitResult = await runGit('commit', () => this.git.commit(message))
    if (commitResult.isErr()) return err(commitResult.error)

    const pushResult = await runGit('push', () =>
      this.git.push('origin', this.config.branch),
    )
    if (pushResult.isErr()) return err(pushResult.error)

    return ok({ committed: true })
  }

  cleanup(): Result<void, GitOperationError> {
    return trySync('cleanup', () => {
      const st = statSync(this.cloneDir)
      if (st.isDirectory()) {
        rmSync(this.cloneDir, { recursive: true, force: true })
      }
    })
  }
}
