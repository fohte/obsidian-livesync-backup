// Type declarations for the esbuild-generated bundle produced by
// `scripts/build-vendor.mjs`. The bundle wraps the
// `DirectFileManipulator` from `vrtmrz/livesync-bridge` (vendored as a git
// submodule under `vendor/livesync-bridge`).
declare module '*/vendor-dist/direct-file-manipulator.mjs' {
  export class DirectFileManipulator {
    // Resolves once the underlying PouchDB instance has connected; methods
    // like enumerateAllNormalDocs() throw if called before this resolves.
    readonly ready: { promise: Promise<void> }
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
  }
}
