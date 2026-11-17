import { describe, expect, it } from 'vitest'

import { mergeText } from '#three-way-merge'

describe('mergeText', () => {
  it('reports a conflict for different insertions at the same position', () => {
    expect(mergeText('a\n', 'a\nvault\n', 'a\nrepo\n')).toEqual(undefined)
  })

  it('merges an insertion at the start boundary of a replacement', () => {
    expect(mergeText('a\nb\nc\n', 'INS\na\nb\nc\n', 'A\nB\nc\n')).toEqual(
      'INS\nA\nB\nc\n',
    )
  })

  it('merges an insertion at the end boundary of a replacement', () => {
    expect(mergeText('a\nb\nc\n', 'a\nb\nINS\nc\n', 'A\nB\nc\n')).toEqual(
      'A\nB\nINS\nc\n',
    )
  })

  it('reports an insertion inside a multi-line replacement as a conflict', () => {
    expect(mergeText('a\nb\nc\n', 'a\nINS\nb\nc\n', 'A\nB\nc\n')).toEqual(
      undefined,
    )
  })

  it('preserves a missing final newline', () => {
    expect(mergeText('a\nb\nc', 'A\nb\nc', 'a\nB\nc')).toEqual('A\nB\nc')
  })

  it('reports a conflict when one side removes the final newline and the other appends a line', () => {
    expect(mergeText('a\nb\n', 'a\nb', 'a\nb\nc\n')).toEqual(undefined)
  })

  it('preserves CRLF line endings', () => {
    expect(
      mergeText('a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n'),
    ).toEqual('A\r\nB\r\nc\r\n')
  })

  it('merges from an empty base', () => {
    expect(mergeText('', '', 'repo\n')).toEqual('repo\n')
  })
})
