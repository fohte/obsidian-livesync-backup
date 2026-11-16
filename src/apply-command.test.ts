import { ok } from 'neverthrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApplyFileChange } from '#apply'

const state = vi.hoisted(() => ({
  changes: [] as ApplyFileChange[],
  currentContent: Buffer.from('current'),
}))

vi.mock('#apply-git', () => ({
  loadApplyChanges: async () => ok(state.changes),
}))

vi.mock('#apply-vault', () => ({
  LivesyncApplyStore: class {
    async read() {
      return ok({ content: state.currentContent, rev: 'test-revision' })
    }

    async readRevision() {
      return ok('test-revision')
    }

    async put() {
      return ok(undefined)
    }

    async delete() {
      return ok(undefined)
    }

    async close() {
      return ok(undefined)
    }
  },
}))

const { runApply } = await import('#apply-command')

const args = [
  '--checkout-path',
  '/repo',
  '--from',
  'base-ref',
  '--to',
  'target-ref',
  '--vault-dir',
  'src',
  '--exclude-author-email',
  'snapshot@example.invalid',
]

const change = {
  commit: 'abcdef123456',
  path: 'note.md',
  before: Buffer.from('parent'),
  after: Buffer.from('pushed'),
}

beforeEach(() => {
  state.changes = [change]
  state.currentContent = Buffer.from('current')
  vi.stubEnv('COUCHDB_URL', 'http://db.example.invalid:5984')
  vi.stubEnv('COUCHDB_USERNAME', 'u')
  vi.stubEnv('COUCHDB_PASSWORD', 'pw')
  vi.stubEnv('COUCHDB_DATABASE', 'test-vault')
  vi.stubEnv('LIVESYNC_PASSPHRASE', 'phrase')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runApply', () => {
  it('returns zero when changes are already present', async () => {
    state.currentContent = Buffer.from('pushed')

    expect(await runApply(args)).toEqual(0)
  })

  it('returns one when a file conflicts', async () => {
    expect(await runApply(args)).toEqual(1)
  })

  it('returns two when arguments are invalid', async () => {
    expect(await runApply([])).toEqual(2)
  })
})
