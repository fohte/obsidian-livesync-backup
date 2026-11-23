export interface CouchDbConfig {
  url: string
  username: string
  password: string
  database: string
  passphrase: string
  obfuscatePassphrase: string | undefined
  enableChunkSplitterV2: boolean
  enableCompression: boolean
  handleFilenameCaseSensitive: boolean
}

export interface ExcludeConfig {
  paths: string[]
  secretPatterns: string[]
}
