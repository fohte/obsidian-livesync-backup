import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeEntry {
  readonly data: string[]
  readonly type: string
  readonly _rev: string
}

interface TestState {
  resolveReady: (() => void) | undefined
  entry: false | FakeEntry
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

    async getById() {
      return state.entry
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

beforeEach(() => {
  state.resolveReady = undefined
  state.entry = false
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
