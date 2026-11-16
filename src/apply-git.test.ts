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

import type { ApplyContent, ApplyFileChange } from '#apply'
import { loadApplyChanges } from '#apply-git'

const contentText = async (
  content: ApplyContent,
): Promise<string | undefined> => {
  if (content === undefined) return undefined
  if (Buffer.isBuffer(content)) return content.toString()
  return (await content.read())._unsafeUnwrap().toString()
}

const summarizeChanges = async (changes: readonly ApplyFileChange[]) =>
  Promise.all(
    changes.map(async (change) => ({
      commit: change.commit,
      path: change.path,
      before: await contentText(change.before),
      after: await contentText(change.after),
    })),
  )

describe('loadApplyChanges', () => {
  it('emits rename as delete and add while skipping the excluded author', async () => {
    const checkoutPath = mkdtempSync(join(tmpdir(), 'livesync-apply-test-'))
    const previousDifferentOwner =
      process.env['GIT_TEST_ASSUME_DIFFERENT_OWNER']
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
      process.env['GIT_TEST_ASSUME_DIFFERENT_OWNER'] = '1'

      const load = async (vaultDir: string) => {
        const result = await loadApplyChanges({
          checkoutPath,
          from,
          to,
          vaultDir,
          excludedAuthorEmail: 'backup-bot@example.invalid',
        })
        return summarizeChanges(result._unsafeUnwrap())
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
      if (previousDifferentOwner === undefined) {
        delete process.env['GIT_TEST_ASSUME_DIFFERENT_OWNER']
      } else {
        process.env['GIT_TEST_ASSUME_DIFFERENT_OWNER'] = previousDifferentOwner
      }
      rmSync(checkoutPath, { recursive: true, force: true })
    }
  })

  it('omits merge commits while keeping their non-bot side commits', async () => {
    const checkoutPath = mkdtempSync(
      join(tmpdir(), 'livesync-apply-merge-test-'),
    )
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
      writeFileSync(join(checkoutPath, 'src', 'note.md'), 'before snapshot')
      git('add', 'src')
      const from = commit('author@example.invalid', 'initial vault')

      git('checkout', '-b', 'snapshot')
      writeFileSync(join(checkoutPath, 'src', 'note.md'), 'backup snapshot')
      git('add', 'src/note.md')
      commit('backup-bot@example.invalid', 'backup snapshot')
      writeFileSync(join(checkoutPath, 'src', 'side.md'), 'side')
      git('add', 'src/side.md')
      const sideCommit = commit('author@example.invalid', 'side change')

      git('checkout', 'main')
      writeFileSync(join(checkoutPath, 'src', 'main.md'), 'main')
      git('add', 'src/main.md')
      const mainCommit = commit('author@example.invalid', 'main change')
      execFileSync(
        'git',
        [
          '-C',
          checkoutPath,
          '-c',
          'user.name=Fixture Author',
          '-c',
          'user.email=author@example.invalid',
          'merge',
          '--no-ff',
          'snapshot',
          '-m',
          'merge snapshot',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const to = git('rev-parse', 'HEAD')

      const result = await loadApplyChanges({
        checkoutPath,
        from,
        to,
        vaultDir: 'src',
        excludedAuthorEmail: 'backup-bot@example.invalid',
      })

      const actual = (await summarizeChanges(result._unsafeUnwrap())).sort(
        (left, right) => (left.path < right.path ? -1 : 1),
      )

      expect(actual).toEqual([
        {
          commit: mainCommit.slice(0, 12),
          path: 'main.md',
          before: undefined,
          after: 'main',
        },
        {
          commit: sideCommit.slice(0, 12),
          path: 'side.md',
          before: undefined,
          after: 'side',
        },
      ])
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true })
    }
  })

  it('includes side-branch commits that do not descend from the from commit', async () => {
    const checkoutPath = mkdtempSync(
      join(tmpdir(), 'livesync-apply-old-branch-test-'),
    )
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
      writeFileSync(join(checkoutPath, 'src', 'base.md'), 'base')
      git('add', 'src')
      commit('author@example.invalid', 'base vault')

      git('checkout', '-b', 'feature')
      writeFileSync(join(checkoutPath, 'src', 'feature.md'), 'feature')
      git('add', 'src/feature.md')
      const featureCommit = commit('author@example.invalid', 'add feature note')

      git('checkout', 'main')
      writeFileSync(join(checkoutPath, 'src', 'main.md'), 'main')
      git('add', 'src/main.md')
      const from = commit('author@example.invalid', 'advance main')
      execFileSync(
        'git',
        [
          '-C',
          checkoutPath,
          '-c',
          'user.name=Fixture Author',
          '-c',
          'user.email=author@example.invalid',
          'merge',
          '--no-ff',
          'feature',
          '-m',
          'merge feature',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const to = git('rev-parse', 'HEAD')

      const result = await loadApplyChanges({
        checkoutPath,
        from,
        to,
        vaultDir: 'src',
        excludedAuthorEmail: 'backup-bot@example.invalid',
      })

      expect(await summarizeChanges(result._unsafeUnwrap())).toEqual([
        {
          commit: featureCommit.slice(0, 12),
          path: 'feature.md',
          before: undefined,
          after: 'feature',
        },
      ])
    } finally {
      rmSync(checkoutPath, { recursive: true, force: true })
    }
  })
})
