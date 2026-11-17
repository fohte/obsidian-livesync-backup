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
  readonly writeConflictStates = new Map<string, VaultState[]>()
  readonly revisionChangeStates = new Map<string, VaultState>()

  async read(path: string) {
    return ok(this.files.get(path) ?? { content: undefined, rev: undefined })
  }

  async readRevision(path: string) {
    const changedState = this.revisionChangeStates.get(path)
    if (changedState) {
      this.files.set(path, changedState)
      this.revisionChangeStates.delete(path)
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
    const conflicts = this.writeConflictStates.get(path)
    const concurrentState = conflicts?.shift()
    if (concurrentState) {
      this.files.set(path, concurrentState)
      return ok(false)
    }
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
    const conflicts = this.writeConflictStates.get(path)
    const concurrentState = conflicts?.shift()
    if (concurrentState) {
      this.files.set(path, concurrentState)
      return ok(false)
    }
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

const snapshotFileBytes = (
  result: ApplyOutcome,
  store: MemoryStore,
  path: string,
) => ({
  result,
  writes: store.writes,
  bytes: [...(store.files.get(path)?.content ?? [])],
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

  it('rechecks and merges when the revision changes after reading', async () => {
    const store = new MemoryStore()
    store.files.set('note.md', {
      content: Buffer.from('first\nsecond\n'),
      rev: 'old-rev',
    })
    store.revisionChangeStates.set('note.md', {
      content: Buffer.from('vault\nsecond\n'),
      rev: 'new-rev',
    })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: Buffer.from('first\nsecond\n'),
          after: Buffer.from('first\nrepo\n'),
        },
      ],
      store,
      () => false,
    )

    expect(snapshot(result._unsafeUnwrap(), store)).toEqual({
      result: { applied: 1, skipped: 0, conflicts: [] },
      writes: ['put:note.md'],
      files: {
        'note.md': { content: 'vault\nrepo\n', rev: '1-rev' },
      },
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
      content: Buffer.from('first\nsecond\n'),
      rev: 'edit-rev',
    })
    store.files.set('remove.md', {
      content: Buffer.from('remove'),
      rev: 'remove-rev',
    })
    store.writeConflictStates.set('edit.md', [
      { content: Buffer.from('vault\nsecond\n'), rev: 'edit-new-rev' },
    ])
    store.writeConflictStates.set('remove.md', [
      { content: Buffer.from('concurrent'), rev: 'remove-new-rev' },
    ])

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'edit.md',
          before: Buffer.from('first\nsecond\n'),
          after: Buffer.from('first\nrepo\n'),
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
        applied: 1,
        skipped: 0,
        conflicts: [{ commit: 'def456', path: 'remove.md' }],
      },
      writes: ['put:edit.md', 'put:edit.md', 'delete:remove.md'],
      files: {
        'edit.md': { content: 'vault\nrepo\n', rev: '2-rev' },
        'remove.md': { content: 'concurrent', rev: 'remove-new-rev' },
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

  it('preserves independent edits on different lines', async () => {
    const store = new MemoryStore()
    store.files.set('note.md', {
      content: Buffer.from('vault\nsecond\nthird\n'),
      rev: 'old-rev',
    })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: Buffer.from('first\nsecond\nthird\n'),
          after: Buffer.from('first\nsecond\nrepo\n'),
        },
      ],
      store,
      () => false,
    )

    expect(snapshot(result._unsafeUnwrap(), store)).toEqual({
      result: { applied: 1, skipped: 0, conflicts: [] },
      writes: ['put:note.md'],
      files: {
        'note.md': { content: 'vault\nsecond\nrepo\n', rev: '1-rev' },
      },
    })
  })

  it('does not write when both sides edit the same line', async () => {
    const store = new MemoryStore()
    store.files.set('note.md', {
      content: Buffer.from('first\nvault\nthird\n'),
      rev: 'old-rev',
    })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: Buffer.from('first\nsecond\nthird\n'),
          after: Buffer.from('first\nrepo\nthird\n'),
        },
      ],
      store,
      () => false,
    )

    expect(snapshot(result._unsafeUnwrap(), store)).toEqual({
      result: {
        applied: 0,
        skipped: 0,
        conflicts: [{ commit: 'abc123', path: 'note.md' }],
      },
      writes: [],
      files: {
        'note.md': { content: 'first\nvault\nthird\n', rev: 'old-rev' },
      },
    })
  })

  it('does not merge invalid UTF-8 content', async () => {
    const store = new MemoryStore()
    store.files.set('note.md', {
      content: Buffer.from([0xff, 0x0a]),
      rev: 'old-rev',
    })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: Buffer.from([0xfe, 0x0a]),
          after: Buffer.from([0xfd, 0x0a]),
        },
      ],
      store,
      () => false,
    )

    expect(snapshotFileBytes(result._unsafeUnwrap(), store, 'note.md')).toEqual(
      {
        result: {
          applied: 0,
          skipped: 0,
          conflicts: [{ commit: 'abc123', path: 'note.md' }],
        },
        writes: [],
        bytes: [0xff, 0x0a],
      },
    )
  })

  it('does not merge deletion and editing in either direction', async () => {
    const store = new MemoryStore()
    store.files.set('repo-delete.md', {
      content: Buffer.from('vault edit'),
      rev: 'repo-delete-rev',
    })
    store.files.set('vault-delete.md', {
      content: undefined,
      rev: undefined,
    })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'repo-delete.md',
          before: Buffer.from('base'),
          after: undefined,
        },
        {
          commit: 'def456',
          path: 'vault-delete.md',
          before: Buffer.from('base'),
          after: Buffer.from('repo edit'),
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
          { commit: 'abc123', path: 'repo-delete.md' },
          { commit: 'def456', path: 'vault-delete.md' },
        ],
      },
      writes: [],
      files: {
        'repo-delete.md': { content: 'vault edit', rev: 'repo-delete-rev' },
        'vault-delete.md': { content: undefined, rev: undefined },
      },
    })
  })

  it('does not overwrite different content at a new file path', async () => {
    const store = new MemoryStore()
    store.files.set('note.md', {
      content: Buffer.from('other'),
      rev: 'old-rev',
    })

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: undefined,
          after: Buffer.from('repo'),
        },
      ],
      store,
      () => false,
    )

    expect(snapshot(result._unsafeUnwrap(), store)).toEqual({
      result: {
        applied: 0,
        skipped: 0,
        conflicts: [{ commit: 'abc123', path: 'note.md' }],
      },
      writes: [],
      files: { 'note.md': { content: 'other', rev: 'old-rev' } },
    })
  })

  it('retries a revision conflict and merges the concurrent edit', async () => {
    const store = new MemoryStore()
    store.files.set('note.md', {
      content: Buffer.from('first\nsecond\nthird\n'),
      rev: 'old-rev',
    })
    store.writeConflictStates.set('note.md', [
      { content: Buffer.from('vault\nsecond\nthird\n'), rev: 'new-rev' },
    ])

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: Buffer.from('first\nsecond\nthird\n'),
          after: Buffer.from('first\nsecond\nrepo\n'),
        },
      ],
      store,
      () => false,
    )

    expect(snapshot(result._unsafeUnwrap(), store)).toEqual({
      result: { applied: 1, skipped: 0, conflicts: [] },
      writes: ['put:note.md', 'put:note.md'],
      files: {
        'note.md': { content: 'vault\nsecond\nrepo\n', rev: '2-rev' },
      },
    })
  })

  it('reports a conflict after exhausting write retries', async () => {
    const store = new MemoryStore()
    store.files.set('note.md', {
      content: Buffer.from('first\nsecond\nthird\n'),
      rev: 'old-rev',
    })
    store.writeConflictStates.set('note.md', [
      { content: Buffer.from('vault\nsecond\nthird\n'), rev: 'new-rev-1' },
      { content: Buffer.from('vault\nsecond\nthird\n'), rev: 'new-rev-2' },
      { content: Buffer.from('vault\nsecond\nthird\n'), rev: 'new-rev-3' },
    ])

    const result = await applyChanges(
      [
        {
          commit: 'abc123',
          path: 'note.md',
          before: Buffer.from('first\nsecond\nthird\n'),
          after: Buffer.from('first\nsecond\nrepo\n'),
        },
      ],
      store,
      () => false,
    )

    expect(snapshot(result._unsafeUnwrap(), store)).toEqual({
      result: {
        applied: 0,
        skipped: 0,
        conflicts: [{ commit: 'abc123', path: 'note.md' }],
      },
      writes: ['put:note.md', 'put:note.md', 'put:note.md'],
      files: {
        'note.md': { content: 'vault\nsecond\nthird\n', rev: 'new-rev-3' },
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

    expect(
      snapshotFileBytes(result._unsafeUnwrap(), store, 'image.png'),
    ).toEqual({
      result: { applied: 1, skipped: 0, conflicts: [] },
      writes: ['put:image.png'],
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

    expect(
      snapshotFileBytes(result._unsafeUnwrap(), store, 'image.png'),
    ).toEqual({
      result: { applied: 1, skipped: 0, conflicts: [] },
      writes: ['put:image.png'],
      bytes: [0, 255, 17],
    })
  })
})
