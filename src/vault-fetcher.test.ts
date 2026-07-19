import { describe, expect, it, vi } from 'vitest'

import type { BackupConfig } from '@/config'

let resolveReady: () => void
let enumerateCalled = false

vi.mock('../vendor-dist/direct-file-manipulator.mjs', () => {
  class DirectFileManipulator {
    readonly ready: { promise: Promise<void> }
    constructor() {
      this.ready = { promise: new Promise<void>((r) => (resolveReady = r)) }
    }
    async *enumerateAllNormalDocs() {
      enumerateCalled = true
      yield { path: 'a.md', data: ['hello'], type: 'plain' }
    }
    async close() {}
  }
  return { DirectFileManipulator }
})

const { LivesyncVaultFetcher } = await import('@/vault-fetcher')

const couchdbConfig: BackupConfig['couchdb'] = {
  url: 'http://couchdb:5984',
  username: 'u',
  password: 'pw',
  database: 'obsidian-v2',
  passphrase: 'phrase',
  obfuscatePassphrase: 'phrase',
  enableChunkSplitterV2: true,
  enableCompression: false,
  handleFilenameCaseSensitive: false,
}

describe('LivesyncVaultFetcher.fetchAll', () => {
  it('waits for DirectFileManipulator to be ready before enumerating docs', async () => {
    enumerateCalled = false
    const fetcher = new LivesyncVaultFetcher(couchdbConfig)
    const iterator = fetcher.fetchAll()[Symbol.asyncIterator]()
    const nextPromise = iterator.next()

    await Promise.resolve()
    await Promise.resolve()
    expect(enumerateCalled).toBe(false)

    resolveReady()
    expect(await nextPromise).toEqual({
      done: false,
      value: { path: 'a.md', content: { kind: 'text', text: 'hello' } },
    })
    expect(enumerateCalled).toBe(true)
  })
})
