import { ok } from 'neverthrow'
import { describe, expect, it } from 'vitest'

import {
  applyChanges,
  type ApplyOutcome,
  type ApplyStore,
  type VaultState,
} from '#apply'

class MemoryStore implements ApplyStore {
  readonly files = new Map<string, VaultState>()
  readonly writes: string[] = []
  changedRevision: string | undefined

  async read(path: string) {
    return ok(this.files.get(path) ?? { content: undefined, rev: undefined })
  }

  async readRevision(path: string) {
    if (this.changedRevision === path) {
      const current = this.files.get(path)
      if (current) this.files.set(path, { ...current, rev: 'new-rev' })
      this.changedRevision = undefined
    }
    return ok(this.files.get(path)?.rev)
  }

  async put(path: string, content: Buffer) {
    this.writes.push(`put:${path}`)
    this.files.set(path, {
      content,
      rev: `${this.writes.length.toString()}-rev`,
    })
    return ok(undefined)
  }

  async delete(path: string) {
    this.writes.push(`delete:${path}`)
    this.files.delete(path)
    return ok(undefined)
  }
}

const snapshot = (result: ApplyOutcome, store: MemoryStore) => ({
  result,
  writes: store.writes,
  files: Object.fromEntries(
    [...store.files].map(([path, state]) => [
      path,
      { content: state.content?.toString(), rev: state.rev },
    ]),
  ),
})

const snapshotCurrent = (result: ApplyOutcome, store: MemoryStore) => ({
  result,
  writes: store.writes,
  current: store.files.get('note.md'),
})

const snapshotBytes = (result: ApplyOutcome, store: MemoryStore) => ({
  result,
  bytes: [...(store.files.get('image.png')?.content ?? [])],
})

describe('applyChanges', () => {
  it('applies changes only when current bytes match the pushed parent', async () => {
    const store = new MemoryStore()
    store.files.set('edit.md', {
      content: Buffer.from('before'),
      rev: 'edit-rev',
    })
    store.files.set('already.md', {
      content: Buffer.from('after'),
      rev: 'already-rev',
    })
    store.files.set('conflict.md', {
      content: Buffer.from('other'),
      rev: 'conflict-rev',
    })
    store.files.set('remove.md', {
      content: Buffer.from('remove'),
      rev: 'remove-rev',
    })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'edit.md',
          before: Buffer.from('before'),
          after: Buffer.from('after'),
        },
        {
          commit: 'abc123',
          path: 'already.md',
          before: Buffer.from('before'),
          after: Buffer.from('after'),
        },
        {
          commit: 'abc123',
          path: 'conflict.md',
          before: Buffer.from('before'),
          after: Buffer.from('after'),
        },
        {
          commit: 'def456',
          path: 'added.md',
          before: undefined,
          after: Buffer.from('added'),
        },
        {
          commit: 'def456',
          path: 'remove.md',
          before: Buffer.from('remove'),
          after: undefined,
        },
        {
          commit: 'def456',
          path: 'excluded.md',
          before: undefined,
          after: Buffer.from('ignored'),
        },
      ],
      store,
      (path) => path === 'excluded.md',
    )

    expect(snapshot(result._unsafeUnwrap(), store)).toEqual({
      result: {
        applied: 3,
        skipped: 2,
        conflicts: [{ commit: 'abc123', path: 'conflict.md' }],
      },
      writes: ['put:edit.md', 'put:added.md', 'delete:remove.md'],
      files: {
        'edit.md': { content: 'after', rev: '1-rev' },
        'added.md': { content: 'added', rev: '2-rev' },
        'already.md': { content: 'after', rev: 'already-rev' },
        'conflict.md': { content: 'other', rev: 'conflict-rev' },
      },
    })
  })

  it('treats a changed revision between compare and write as a conflict', async () => {
    const store = new MemoryStore()
    store.files.set('note.md', {
      content: Buffer.from('parent'),
      rev: 'old-rev',
    })
    store.changedRevision = 'note.md'

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: Buffer.from('parent'),
          after: Buffer.from('pushed'),
        },
      ],
      store,
      () => false,
    )

    expect(snapshotCurrent(result._unsafeUnwrap(), store)).toEqual({
      result: {
        applied: 0,
        skipped: 0,
        conflicts: [{ commit: 'abc123', path: 'note.md' }],
      },
      writes: [],
      current: { content: Buffer.from('parent'), rev: 'new-rev' },
    })
  })

  it('compares binary content byte-for-byte', async () => {
    const store = new MemoryStore()
    store.files.set('image.png', {
      content: Buffer.from([0, 255, 16]),
      rev: 'old-rev',
    })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'image.png',
          before: Buffer.from([0, 255, 16]),
          after: Buffer.from([0, 255, 17]),
        },
      ],
      store,
      () => false,
    )

    expect(snapshotBytes(result._unsafeUnwrap(), store)).toEqual({
      result: { applied: 1, skipped: 0, conflicts: [] },
      bytes: [0, 255, 17],
    })
  })
})
