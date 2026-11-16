import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApplyStore } from '#apply'

interface FakeEntry {
  readonly data: string[]
  readonly type: string
  readonly _rev: string
}

interface TestState {
  resolveReady: (() => void) | undefined
  entry: false | FakeEntry
  getByIdError: (Error & { readonly status: number }) | undefined
  rawEntry: false
  put:
    | {
        readonly path: string
        readonly type: string
        readonly blobType: string
        readonly bytes: number[]
      }
    | undefined
}

const state = vi.hoisted<TestState>(() => ({
  resolveReady: undefined,
  entry: false,
  getByIdError: undefined,
  rawEntry: false,
  put: undefined,
}))

vi.mock('../vendor-dist/direct-file-manipulator.mjs', () => {
  class DirectFileManipulator {
    readonly ready: { promise: Promise<void> }
    $$getReplicator: () => unknown = () => {
      throw new Error('Method not implemented.')
    }

    constructor() {
      this.ready = {
        promise: new Promise<void>((resolve) => {
          state.resolveReady = resolve
        }),
      }
    }

    async path2id(path: string) {
      return path
    }

    getById() {
      if (state.getByIdError !== undefined) {
        return Promise.reject(state.getByIdError)
      }
      return Promise.resolve(state.entry)
    }

    async rawGet() {
      return state.rawEntry
    }

    async put(path: string, blob: Blob, _info: unknown, type: string) {
      state.put = {
        path,
        type,
        blobType: blob.type,
        bytes: [...new Uint8Array(await blob.arrayBuffer())],
      }
      return true
    }

    async delete() {
      return true
    }

    async close() {}
  }
  return { DirectFileManipulator }
})

const { LivesyncApplyStore } = await import('#apply-vault')

const couchdbConfig = () => ({
  url: 'http://db.example.invalid:5984',
  username: 'u',
  password: 'pw',
  database: 'test-vault',
  passphrase: 'phrase',
  obfuscatePassphrase: 'phrase',
  enableChunkSplitterV2: true,
  enableCompression: false,
  handleFilenameCaseSensitive: false,
})

const snapshotPut = () => ({
  status: state.put === undefined ? 'not-written' : 'written',
  put: state.put,
})

const snapshotMissingDocument = async (store: ApplyStore) => ({
  state: (await store.read('notes/new.md'))._unsafeUnwrap(),
  revision: (await store.readRevision('notes/new.md'))._unsafeUnwrap(),
})

beforeEach(() => {
  state.resolveReady = undefined
  state.entry = false
  state.getByIdError = undefined
  state.rawEntry = false
  state.put = undefined
})

describe('LivesyncApplyStore', () => {
  it('decodes binary entries and preserves the revision from the same entry', async () => {
    state.entry = {
      data: [Buffer.from([0, 255, 16]).toString('base64')],
      type: 'newnote',
      _rev: '3-test-revision',
    }
    const store = new LivesyncApplyStore(couchdbConfig())
    state.resolveReady?.()

    const result = await store.read('files/picture.bin')

    expect(result._unsafeUnwrap()).toEqual({
      content: Buffer.from([0, 255, 16]),
      rev: '3-test-revision',
    })
  })

  it('treats a CouchDB 404 as a missing vault document', async () => {
    state.getByIdError = Object.assign(new Error('missing document'), {
      status: 404,
    })
    const store = new LivesyncApplyStore(couchdbConfig())
    state.resolveReady?.()

    expect(await snapshotMissingDocument(store)).toEqual({
      state: { content: undefined, rev: undefined },
      revision: undefined,
    })
  })

  it('stores valid UTF-8 JSON as plain text so backup masking can inspect it', async () => {
    const store = new LivesyncApplyStore(couchdbConfig())
    state.resolveReady?.()
    const content = Buffer.from('{"token":"redacted"}')

    await store.put('settings.json', content)

    expect(snapshotPut()).toEqual({
      status: 'written',
      put: {
        path: 'settings.json',
        type: 'plain',
        blobType: 'text/plain',
        bytes: [...content],
      },
    })
  })
})
