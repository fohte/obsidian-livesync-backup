import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApplyStore } from '#apply'

interface FakeEntry {
  readonly ctime?: number
  readonly data: string[]
  readonly type: string
  readonly _rev: string
}

interface TestState {
  resolveReady: (() => void) | undefined
  entry: false | FakeEntry
  getByIdError: (Error & { readonly status: number }) | undefined
  rawEntry: false | { readonly _rev?: string; readonly ctime?: number }
  databaseRevision: string | undefined
  advanceBeforeMetadataPut: boolean
  advanceBeforeDelete: boolean
  databasePut:
    | {
        readonly id: string
        readonly revision: string | undefined
        readonly force: boolean
      }
    | undefined
  databaseDelete:
    { readonly path: string; readonly revision: string | undefined } | undefined
  put:
    | {
        readonly path: string
        readonly type: string
        readonly blobType: string
        readonly bytes: number[]
        readonly ctime: number
      }
    | undefined
}

const state = vi.hoisted<TestState>(() => ({
  resolveReady: undefined,
  entry: false,
  getByIdError: undefined,
  rawEntry: false,
  databaseRevision: undefined,
  advanceBeforeMetadataPut: false,
  advanceBeforeDelete: false,
  databasePut: undefined,
  databaseDelete: undefined,
  put: undefined,
}))

vi.mock('../vendor-dist/direct-file-manipulator.mjs', () => {
  class DirectFileManipulator {
    readonly ready: { promise: Promise<void> }
    readonly liveSyncLocalDB = {
      localDatabase: {
        put: (
          doc: { readonly _id: string; readonly _rev?: string },
          options?: { readonly force?: boolean },
        ) => {
          state.databasePut = {
            id: doc._id,
            revision: doc._rev,
            force: options?.force ?? false,
          }
          if (state.advanceBeforeMetadataPut) {
            state.databaseRevision = 'raced-revision'
            state.advanceBeforeMetadataPut = false
          }
          if (doc._rev !== state.databaseRevision) {
            return Promise.reject(
              Object.assign(new Error('revision changed'), { status: 409 }),
            )
          }
          state.databaseRevision = 'written-revision'
          return Promise.resolve({ ok: true })
        },
      },
      deleteDBEntry: (path: string, options?: { readonly rev?: string }) => {
        state.databaseDelete = { path, revision: options?.rev }
        if (state.advanceBeforeDelete) {
          state.databaseRevision = 'raced-revision'
          state.advanceBeforeDelete = false
        }
        if (options?.rev !== state.databaseRevision) {
          return Promise.reject(
            Object.assign(new Error('revision changed'), { status: 409 }),
          )
        }
        state.databaseRevision = 'deleted-revision'
        return Promise.resolve(true)
      },
    }
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

    async put(path: string, blob: Blob, info: { ctime: number }, type: string) {
      const revision = state.databaseRevision
      await this.liveSyncLocalDB.localDatabase.put(
        { _id: path, ...(revision === undefined ? {} : { _rev: revision }) },
        { force: true },
      )
      state.put = {
        path,
        type,
        blobType: blob.type,
        bytes: [...new Uint8Array(await blob.arrayBuffer())],
        ctime: info.ctime,
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

const snapshotPut = (result: boolean) => ({
  result,
  status: state.put === undefined ? 'not-written' : 'written',
  put: state.put,
  databasePut: state.databasePut,
})

const snapshotWriteConflict = (result: boolean) => ({
  result,
  databaseRevision: state.databaseRevision,
  databasePut: state.databasePut,
  put: state.put,
})

const snapshotDeleteConflict = (result: boolean) => ({
  result,
  databaseRevision: state.databaseRevision,
  databaseDelete: state.databaseDelete,
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
  state.databaseRevision = undefined
  state.advanceBeforeMetadataPut = false
  state.advanceBeforeDelete = false
  state.databasePut = undefined
  state.databaseDelete = undefined
  state.put = undefined
})

describe('LivesyncApplyStore', () => {
  it('decodes binary entries and preserves the revision from the same entry', async () => {
    state.entry = {
      data: [Buffer.from([0, 255, 16]).toString('base64')],
      type: 'newnote',
      _rev: '3-test-revision',
      ctime: 123,
    }
    state.rawEntry = { _rev: '3-test-revision', ctime: 123 }
    const store = new LivesyncApplyStore(couchdbConfig())
    state.resolveReady?.()

    const result = await store.read('files/picture.bin')

    expect(result._unsafeUnwrap()).toEqual({
      content: Buffer.from([0, 255, 16]),
      rev: '3-test-revision',
      ctime: 123,
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
    state.databaseRevision = '3-test-revision'
    const content = Buffer.from('{"token":"redacted"}')

    const result = await store.put(
      'settings.json',
      content,
      '3-test-revision',
      123,
    )

    expect(snapshotPut(result._unsafeUnwrap())).toEqual({
      result: true,
      status: 'written',
      put: {
        path: 'settings.json',
        type: 'plain',
        blobType: 'text/plain',
        bytes: [...content],
        ctime: 123,
      },
      databasePut: {
        id: 'settings.json',
        revision: '3-test-revision',
        force: false,
      },
    })
  })

  it('keeps a concurrent metadata update when it races with a write', async () => {
    const store = new LivesyncApplyStore(couchdbConfig())
    state.resolveReady?.()
    state.databaseRevision = 'checked-revision'
    state.advanceBeforeMetadataPut = true

    const result = await store.put(
      'notes/raced.md',
      Buffer.from('pushed'),
      'checked-revision',
      123,
    )

    expect(snapshotWriteConflict(result._unsafeUnwrap())).toEqual({
      result: false,
      databaseRevision: 'raced-revision',
      databasePut: {
        id: 'notes/raced.md',
        revision: 'checked-revision',
        force: false,
      },
      put: undefined,
    })
  })

  it('keeps a concurrent metadata update when it races with a deletion', async () => {
    const store = new LivesyncApplyStore(couchdbConfig())
    state.resolveReady?.()
    state.databaseRevision = 'checked-revision'
    state.advanceBeforeDelete = true

    const result = await store.delete('notes/raced.md', 'checked-revision')

    expect(snapshotDeleteConflict(result._unsafeUnwrap())).toEqual({
      result: false,
      databaseRevision: 'raced-revision',
      databaseDelete: {
        path: 'notes/raced.md',
        revision: 'checked-revision',
      },
    })
  })
})
