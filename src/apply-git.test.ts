import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadApplyChanges } from '#apply-git'

describe('loadApplyChanges', () => {
  it('emits rename as delete and add while skipping the excluded author', async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), 'livesync-apply-test-'))
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', checkoutPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    const commit = (email: string, message: string): string => {
      execFileSync(
        'git',
        [
          '-C',
          checkoutPath,
          '-c',
          'user.name=Fixture Author',
          '-c',
          `user.email=${email}`,
          'commit',
          '-m',
          message,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      return git('rev-parse', 'HEAD')
    }

    try {
      git('init', '-b', 'main')
      mkdirSync(join(checkoutPath, 'src'))
      writeFileSync(join(checkoutPath, 'src', 'before.md'), 'before')
      git('add', 'src')
      const from = commit('author@example.invalid', 'initial vault')

      renameSync(
        join(checkoutPath, 'src', 'before.md'),
        join(checkoutPath, 'src', 'after.md'),
      )
      git('add', '-A')
      const renameCommit = commit('author@example.invalid', 'rename note')

      writeFileSync(join(checkoutPath, 'src', 'after.md'), 'bot snapshot')
      git('add', 'src/after.md')
      const to = commit('backup-bot@example.invalid', 'backup snapshot')

      const load = async (vaultDir: string) => {
        const result = await loadApplyChanges({
          checkoutPath,
          from,
          to,
          vaultDir,
          excludedAuthorEmail: 'backup-bot@example.invalid',
        })
        return Promise.all(
          result._unsafeUnwrap().map(async (change) => ({
            commit: change.commit,
            path: change.path,
            before:
              change.before === undefined
                ? undefined
                : Buffer.isBuffer(change.before)
                  ? change.before.toString()
                  : (await change.before.read())._unsafeUnwrap().toString(),
            after:
              change.after === undefined
                ? undefined
                : Buffer.isBuffer(change.after)
                  ? change.after.toString()
                  : (await change.after.read())._unsafeUnwrap().toString(),
          })),
        )
      }

      const snapshotChanges = async () => ({
        scoped: await load('src/'),
        root: await load('.'),
      })

      expect(await snapshotChanges()).toEqual({
        scoped: [
          {
            commit: renameCommit.slice(0, 12),
            path: 'after.md',
            before: undefined,
            after: 'before',
          },
          {
            commit: renameCommit.slice(0, 12),
            path: 'before.md',
            before: 'before',
            after: undefined,
          },
        ],
        root: [
          {
            commit: renameCommit.slice(0, 12),
            path: 'src/after.md',
            before: undefined,
            after: 'before',
          },
          {
            commit: renameCommit.slice(0, 12),
            path: 'src/before.md',
            before: 'before',
            after: undefined,
          },
        ],
      })
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true })
    }
  })
})
