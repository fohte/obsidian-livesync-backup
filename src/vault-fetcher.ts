import type { BackupConfig } from '@/config'

import { DirectFileManipulator } from '../vendor-dist/direct-file-manipulator.mjs'

export interface VaultFile {
  readonly path: string
  readonly content: string
}

export interface VaultFetcher {
  fetchAll(): AsyncIterable<VaultFile>
  close(): Promise<void>
}

export class LivesyncVaultFetcher implements VaultFetcher {
  private readonly dfm: DirectFileManipulator

  constructor(config: BackupConfig['couchdb']) {
    this.dfm = new DirectFileManipulator({
      url: config.url,
      username: config.username,
      password: config.password,
      database: config.database,
      passphrase: config.passphrase,
      obfuscatePassphrase: config.passphrase,
      customChunkSize: 100,
      enableChunkSplitterV2: true,
      enableCompression: false,
      handleFilenameCaseSensitive: false,
    })
  }

  async *fetchAll(): AsyncIterable<VaultFile> {
    for await (const entry of this.dfm.enumerateAllNormalDocs({
      metaOnly: false,
    })) {
      if (entry === false) continue
      const path = entry.path
      if (path.length === 0) continue
      yield { path, content: entry.data.join('') }
    }
  }

  async close(): Promise<void> {
    await this.dfm.close()
  }
}
