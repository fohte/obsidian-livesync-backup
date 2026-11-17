import DiffMatchPatchConstructor from 'diff-match-patch'

interface Hunk {
  readonly start: number
  readonly end: number
  readonly replacement: readonly string[]
}

const splitLines = (text: string): string[] =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? []

const lineCount = (text: string): number => splitLines(text).length

const changesFrom = (base: string, side: string): Hunk[] => {
  const diffMatchPatch = new DiffMatchPatchConstructor()
  diffMatchPatch.Diff_Timeout = 1
  const encoded = diffMatchPatch.diff_linesToChars_(base, side)
  const diffs = diffMatchPatch.diff_main(encoded.chars1, encoded.chars2, false)
  diffMatchPatch.diff_charsToLines_(diffs, encoded.lineArray)

  const changes: Hunk[] = []
  let position = 0
  let pendingStart: number | undefined
  let pendingEnd = 0
  let replacement: string[] = []

  const flush = () => {
    if (pendingStart === undefined) return
    changes.push({
      start: pendingStart,
      end: pendingEnd,
      replacement,
    })
    pendingStart = undefined
    replacement = []
  }

  for (const [operation, text] of diffs) {
    if (operation === 0) {
      flush()
      position += lineCount(text)
      continue
    }
    pendingStart ??= position
    if (operation === -1) {
      position += lineCount(text)
      pendingEnd = position
    } else {
      replacement.push(...splitLines(text))
      pendingEnd = position
    }
  }
  flush()

  return changes
}

const sameHunk = (left: Hunk, right: Hunk): boolean =>
  left.start === right.start &&
  left.end === right.end &&
  left.replacement.length === right.replacement.length &&
  left.replacement.every((line, index) => line === right.replacement[index])

const overlaps = (left: Hunk, right: Hunk): boolean => {
  if (left.start === left.end && right.start === right.end) {
    return left.start === right.start
  }
  if (left.start === left.end) {
    return left.start > right.start && left.start < right.end
  }
  if (right.start === right.end) {
    return right.start > left.start && right.start < left.end
  }
  return left.start < right.end && right.start < left.end
}

export const mergeText = (
  base: string,
  current: string,
  pushed: string,
): string | undefined => {
  const currentChanges = changesFrom(base, current)
  const pushedChanges = changesFrom(base, pushed)

  for (const currentChange of currentChanges) {
    for (const pushedChange of pushedChanges) {
      if (sameHunk(currentChange, pushedChange)) continue
      if (overlaps(currentChange, pushedChange)) return undefined
    }
  }

  const changes = [...currentChanges]
  for (const pushedChange of pushedChanges) {
    if (!currentChanges.some((change) => sameHunk(change, pushedChange))) {
      changes.push(pushedChange)
    }
  }
  changes.sort(
    (left, right) =>
      left.start - right.start ||
      (left.start === left.end ? -1 : 1) -
        (right.start === right.end ? -1 : 1) ||
      left.end - right.end,
  )

  const baseLines = splitLines(base)
  const result: string[] = []
  let position = 0
  for (const change of changes) {
    result.push(...baseLines.slice(position, change.start))
    result.push(...change.replacement)
    position = change.end
  }
  result.push(...baseLines.slice(position))
  return result.join('')
}
