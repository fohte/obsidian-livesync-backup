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

import { type SimpleGit, simpleGit } from 'simple-git'

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

  async clone(): Promise<void> {
    const url = authedRepoUrl(this.config.repository, this.config.token)
    await this.git.clone(url, this.cloneDir, [
      '--depth=1',
      '--branch',
      this.config.branch,
      '--single-branch',
    ])
    await this.git.addConfig('user.name', COMMIT_AUTHOR_NAME)
    await this.git.addConfig('user.email', COMMIT_AUTHOR_EMAIL)
  }

  /**
   * Replaces the contents of the vault subdir with `files`. Existing files
   * inside the subdir are removed first so deletions in the source are
   * reflected.
   */
  async syncFiles(
    files: ReadonlyArray<{ path: string; content: string }>,
  ): Promise<void> {
    const vaultRoot = join(this.cloneDir, this.config.vaultSubdir)
    await mkdir(vaultRoot, { recursive: true })
    if (!isPathInside(this.cloneDir, vaultRoot)) {
      throw new Error('vaultSubdir escapes clone directory')
    }
    removeAllFiles(vaultRoot)
    for (const file of files) {
      const normalized = posix.normalize(file.path).replace(/^\/+/, '')
      if (normalized.startsWith('../') || normalized.includes('/../')) {
        throw new Error('invalid vault file path')
      }
      const dest = join(vaultRoot, normalized)
      if (!isPathInside(vaultRoot, dest)) {
        throw new Error('vault file path escapes vault subdir')
      }
      await mkdir(dirname(dest), { recursive: true })
      writeFileSync(dest, file.content)
    }
  }

  async commitAndPush(message: string): Promise<CommitOutcome> {
    await this.git.add(['-A', this.config.vaultSubdir])
    const status = await this.git.status()
    if (status.files.length === 0) {
      return { committed: false }
    }
    await this.git.commit(message)
    await this.git.push('origin', this.config.branch)
    return { committed: true }
  }

  cleanup(): void {
    try {
      const st = statSync(this.cloneDir)
      if (st.isDirectory()) {
        rmSync(this.cloneDir, { recursive: true, force: true })
      }
    } catch {
      // ignore
    }
  }
}
