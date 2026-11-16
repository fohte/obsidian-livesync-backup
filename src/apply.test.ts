import { createHash } from 'node:crypto'

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
  readonly writeCtimes: (number | undefined)[] = []
  readonly writeConflictPaths = new Set<string>()
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

  async put(
    path: string,
    content: Buffer,
    expectedRevision: string | undefined,
    ctime?: number,
  ) {
    this.writes.push(`put:${path}`)
    this.writeCtimes.push(ctime)
    if (this.files.get(path)?.rev !== expectedRevision) return ok(false)
    if (this.writeConflictPaths.delete(path)) return ok(false)
    this.files.set(path, {
      content,
      rev: `${this.writes.length.toString()}-rev`,
      ...(ctime === undefined ? {} : { ctime }),
    })
    return ok(true)
  }

  async delete(path: string, expectedRevision: string | undefined) {
    this.writes.push(`delete:${path}`)
    if (this.files.get(path)?.rev !== expectedRevision) return ok(false)
    if (this.writeConflictPaths.delete(path)) return ok(false)
    this.files.delete(path)
    return ok(true)
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

const snapshotWriteMetadata = (result: ApplyOutcome, store: MemoryStore) => ({
  result,
  writes: store.writes,
  ctimes: store.writeCtimes,
})

const gitBlob = (content: Buffer) => ({
  objectId: createHash('sha1')
    .update(`blob ${content.byteLength.toString()}\0`)
    .update(content)
    .digest('hex'),
  objectFormat: 'sha1' as const,
  read: () => Promise.resolve(ok(content)),
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

  it('preserves the existing creation time when applying an edit', async () => {
    const store = new MemoryStore()
    const existing = {
      content: Buffer.from('before'),
      rev: 'old-rev',
      ctime: 123,
    }
    store.files.set('note.md', existing)

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: Buffer.from('before'),
          after: Buffer.from('after'),
        },
      ],
      store,
      () => false,
    )

    expect(snapshotWriteMetadata(result._unsafeUnwrap(), store)).toEqual({
      result: { applied: 1, skipped: 0, conflicts: [] },
      writes: ['put:note.md'],
      ctimes: [123],
    })
  })

  it('reports conflicts when conditional writes detect a concurrent edit', async () => {
    const store = new MemoryStore()
    store.files.set('edit.md', {
      content: Buffer.from('before'),
      rev: 'edit-rev',
    })
    store.files.set('remove.md', {
      content: Buffer.from('remove'),
      rev: 'remove-rev',
    })
    store.writeConflictPaths.add('edit.md')
    store.writeConflictPaths.add('remove.md')

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'edit.md',
          before: Buffer.from('before'),
          after: Buffer.from('after'),
        },
        {
          commit: 'def456',
          path: 'remove.md',
          before: Buffer.from('remove'),
          after: undefined,
        },
      ],
      store,
      () => false,
    )

    expect(snapshot(result._unsafeUnwrap(), store)).toEqual({
      result: {
        applied: 0,
        skipped: 0,
        conflicts: [
          { commit: 'abc123', path: 'edit.md' },
          { commit: 'def456', path: 'remove.md' },
        ],
      },
      writes: ['put:edit.md', 'delete:remove.md'],
      files: {
        'edit.md': { content: 'before', rev: 'edit-rev' },
        'remove.md': { content: 'remove', rev: 'remove-rev' },
      },
    })
  })

  it('skips earlier edits when the vault already has a later pushed state', async () => {
    const store = new MemoryStore()
    store.files.set('note.md', {
      content: Buffer.from('final'),
      rev: 'final-rev',
    })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: Buffer.from('initial'),
          after: Buffer.from('middle'),
        },
        {
          commit: 'def456',
          path: 'note.md',
          before: Buffer.from('middle'),
          after: Buffer.from('final'),
        },
      ],
      store,
      () => false,
    )

    expect(snapshot(result._unsafeUnwrap(), store)).toEqual({
      result: { applied: 0, skipped: 2, conflicts: [] },
      writes: [],
      files: {
        'note.md': { content: 'final', rev: 'final-rev' },
      },
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

  it('loads Git blobs only when byte comparisons or writes need them', async () => {
    const store = new MemoryStore()
    const before = Buffer.from([0, 255, 16])
    const after = Buffer.from([0, 255, 17])
    store.files.set('image.png', { content: before, rev: 'old-rev' })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'image.png',
          before: gitBlob(before),
          after: gitBlob(after),
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
