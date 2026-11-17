declare module 'diff-match-patch' {
  interface LineDiff {
    readonly chars1: string
    readonly chars2: string
    readonly lineArray: readonly string[]
  }

  type Diff = [operation: number, text: string]

  export default class DiffMatchPatch {
    Diff_Timeout: number
    diff_linesToChars_(left: string, right: string): LineDiff
    diff_main(left: string, right: string, checkLines?: boolean): Diff[]
    diff_charsToLines_(diffs: Diff[], lineArray: readonly string[]): void
  }
}
