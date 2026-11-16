// Type declarations for the esbuild-generated bundle produced by
// `scripts/build-vendor.mjs`. The bundle wraps the
// `DirectFileManipulator` from `vrtmrz/livesync-bridge` (vendored as a git
// submodule under `vendor/livesync-bridge`).
declare module '*/vendor-dist/direct-file-manipulator.mjs' {
  export class DirectFileManipulator {
    readonly liveSyncLocalDB: {
      readonly localDatabase: {
        put(
          doc: { _id: string; _rev?: string },
          options?: { force?: boolean },
        ): Promise<unknown>
      }
      deleteDBEntry(path: string, options?: { rev?: string }): Promise<boolean>
    }
    // Resolves once the underlying PouchDB instance has connected; methods
    // like enumerateAllNormalDocs() throw if called before this resolves.
    readonly ready: { promise: Promise<void> }
    path2id(path: string): Promise<string>
    get(
      path: string,
      metaOnly?: boolean,
    ): Promise<
      | false
      | {
          data: string[]
          type?: string
          deleted?: boolean
        }
    >
    getById(
      id: string,
      metaOnly?: boolean,
    ): Promise<
      | false
      | {
          _rev?: string
          data: string[]
          type?: string
          deleted?: boolean
        }
    >
    rawGet<T>(id: string): Promise<false | T>
    put(
      path: string,
      data: Blob,
      info: { ctime: number; mtime: number; size: number },
      type?: 'newnote' | 'plain',
    ): Promise<boolean>
    delete(path: string): Promise<boolean>
    constructor(options: {
      url: string
      username: string
      password: string
      passphrase: string | undefined
      database: string
      obfuscatePassphrase: string | undefined
      customChunkSize?: number
      enableChunkSplitterV2?: boolean
      enableCompression?: boolean
      handleFilenameCaseSensitive?: boolean
    })
    enumerateAllNormalDocs(opt: { metaOnly: boolean }): AsyncIterable<
      | false
      | {
          path: string
          data: string[]
          /** "plain" for UTF-8 text, "newnote" for base64-encoded binary. */
          type?: string
        }
    >
    close(): Promise<void>
    // Stub that unconditionally throws "Method not implemented." in CLI
    // usage (there is no replicator); see vault-fetcher.ts for why it gets
    // overwritten right after construction.
    $$getReplicator: () => unknown
  }
}
