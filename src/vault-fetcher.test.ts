import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackupConfig } from '#config'

type FakeEntry = false | { path: string; data: string[]; type?: string }

const state = vi.hoisted(() => ({
  resolveReady: undefined as (() => void) | undefined,
  entries: [] as FakeEntry[],
  enumerateCallCount: 0,
  lastInstance: undefined as { $$getReplicator: () => unknown } | undefined,
  throwAfterEntries: undefined as Error | undefined,
}))

vi.mock('../vendor-dist/direct-file-manipulator.mjs', () => {
  class DirectFileManipulator {
    readonly ready: { promise: Promise<void> }
    // Mirrors the real upstream stub: it throws until vault-fetcher.ts
    // overwrites it right after construction.
    $$getReplicator: () => unknown = () => {
      throw new Error('Method not implemented.')
    }
    constructor() {
      this.ready = {
        promise: new Promise<void>((resolve) => {
          state.resolveReady = resolve
        }),
      }
      state.lastInstance = this
    }
    async *enumerateAllNormalDocs() {
      state.enumerateCallCount++
      for (const entry of state.entries) yield entry
      if (state.throwAfterEntries) throw state.throwAfterEntries
    }
    async close() {}
  }
  return { DirectFileManipulator }
})

const { LivesyncVaultFetcher, MissingChunkError, VaultFetcherTimeoutError } =
  await import('#vault-fetcher')

// Every field is irrelevant to the contracts under test: DirectFileManipulator
// itself is replaced by the mock above, so none of these values are read.
const couchdbConfig = (): BackupConfig['couchdb'] => ({
  url: 'http://couchdb:5984',
  username: 'u',
  password: 'pw',
  database: 'obsidian-v2',
  passphrase: 'phrase',
  obfuscatePassphrase: 'phrase',
  enableChunkSplitterV2: true,
  enableCompression: false,
  handleFilenameCaseSensitive: false,
})

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}

const flushMicrotasks = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  state.resolveReady = undefined
  state.entries = []
  state.enumerateCallCount = 0
  state.lastInstance = undefined
  state.throwAfterEntries = undefined
})

describe('LivesyncVaultFetcher.fetchAll', () => {
  it('does not enumerate docs until the CouchDB connection is ready', async () => {
    const fetcher = new LivesyncVaultFetcher(couchdbConfig())
    const done = collect(fetcher.fetchAll())

    await flushMicrotasks()
    expect(state.enumerateCallCount).toBe(0)

    state.resolveReady?.()
    await done

    expect(state.enumerateCallCount).toBe(1)
  })

  it('maps raw entries to vault files, skipping unusable ones', async () => {
    state.entries = [
      { path: 'notes/a.md', data: ['hello ', 'world'], type: 'plain' },
      {
        path: 'attachments/photo.jpg',
        data: [Buffer.from([0xff, 0xd8]).toString('base64')],
        type: 'newnote',
      },
      false,
      { path: '', data: ['x'], type: 'plain' },
      { path: 'internal/ignored', data: ['x'], type: 'other' },
    ]
    const fetcher = new LivesyncVaultFetcher(couchdbConfig())
    const done = collect(fetcher.fetchAll())
    state.resolveReady?.()

    expect(await done).toEqual([
      { path: 'notes/a.md', content: { kind: 'text', text: 'hello world' } },
      {
        path: 'attachments/photo.jpg',
        content: { kind: 'binary', bytes: Buffer.from([0xff, 0xd8]) },
      },
    ])
  })

  it('rejects with VaultFetcherTimeoutError when the connection never becomes ready', async () => {
    vi.useFakeTimers()
    try {
      const fetcher = new LivesyncVaultFetcher(couchdbConfig())
      const done = collect(fetcher.fetchAll())
      const advance = vi.advanceTimersByTimeAsync(30_000)

      await expect(done).rejects.toBeInstanceOf(VaultFetcherTimeoutError)
      await advance
    } finally {
      vi.useRealTimers()
    }
  })

  // This checks the constructor patches the stub itself, not the downstream
  // crash-avoidance effect: reproducing that would require mocking
  // ChunkFetcher's internal setTimeout/EventTarget dispatch, which is out of
  // scope for this file's third-party boundary.
  it('replaces the upstream $$getReplicator stub, which otherwise throws on every missing-chunk fetch attempt', () => {
    new LivesyncVaultFetcher(couchdbConfig())
    expect(state.lastInstance?.$$getReplicator()).toBeUndefined()
  })

  it('wraps a "Corrupted document" failure as MissingChunkError, extracting the path', async () => {
    state.entries = [{ path: 'notes/a.md', data: ['ok'], type: 'plain' }]
    state.throwAfterEntries = new Error(
      'Corrupted document: notes/inbox/broken.md',
    )
    const fetcher = new LivesyncVaultFetcher(couchdbConfig())
    const done = collect(fetcher.fetchAll())
    state.resolveReady?.()

    const caught: unknown = await done.catch((e: unknown) => e)
    expect(caught).toEqual(
      new MissingChunkError('notes/inbox/broken.md', state.throwAfterEntries),
    )
  })

  it('propagates enumeration failures unrelated to missing chunks unchanged', async () => {
    const boom = new Error('boom')
    state.throwAfterEntries = boom
    const fetcher = new LivesyncVaultFetcher(couchdbConfig())
    const done = collect(fetcher.fetchAll())
    state.resolveReady?.()

    await expect(done).rejects.toBe(boom)
  })
})
