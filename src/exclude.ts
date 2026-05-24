import { minimatch } from 'minimatch'

const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  '.obsidian/plugins/obsidian-livesync/data.json',
  '.trash/**',
  '**/*.tmp',
]

export interface ExcludeFilterOptions {
  readonly paths: readonly string[]
  readonly secretPatterns: readonly string[]
}

export interface ContentScanResult {
  readonly content: string | null
  readonly maskedCount: number
}

export class ExcludeFilter {
  private readonly pathGlobs: readonly string[]
  private readonly secretRegexps: readonly RegExp[]

  constructor(options: ExcludeFilterOptions) {
    this.pathGlobs = [...DEFAULT_EXCLUDE_GLOBS, ...options.paths]
    this.secretRegexps = options.secretPatterns.map(
      (pat) => new RegExp(pat, 'g'),
    )
  }

  /** Returns true if the path is excluded by path-based rules. */
  isPathExcluded(path: string): boolean {
    return this.pathGlobs.some((glob) =>
      minimatch(path, glob, { dot: true, matchBase: false }),
    )
  }

  /**
   * Scan file content for secret patterns. If any pattern matches, masked
   * content is returned. Returns `content: null` when the file should be
   * excluded entirely (currently never — masking is the default response).
   */
  scanContent(content: string): ContentScanResult {
    if (this.secretRegexps.length === 0) {
      return { content, maskedCount: 0 }
    }
    let maskedCount = 0
    let next = content
    for (const re of this.secretRegexps) {
      next = next.replace(re, () => {
        maskedCount += 1
        return '***REDACTED***'
      })
    }
    return { content: next, maskedCount }
  }
}
