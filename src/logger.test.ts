import { describe, expect, it } from 'vitest'

import { SafeLogger } from '#logger'

const collect = (): {
  sink: { write: (l: string) => void }
  lines: string[]
} => {
  const lines: string[] = []
  return { sink: { write: (l) => lines.push(l) }, lines }
}

describe('SafeLogger', () => {
  it('writes only the whitelisted fields', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.info('fetch_done', { fetched: 12, excluded: 3, masked: 0 })
    expect(lines).toEqual([
      'level=info event=fetch_done fetched=12 excluded=3 masked=0',
    ])
  })

  it('drops unknown field names', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.info('fetch_done', {
      fetched: 1,
      unknown_field: 'x',
      content: 'plaintext',
    })
    expect(lines[0]).toBe('level=info event=fetch_done fetched=1')
  })

  it('writes generic known keys whose values have a safe shape', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.error('backup_failed', {
      kind: 'auth_failed',
      step: 'git_push',
    })
    expect(lines[0]).toBe(
      'level=error event=backup_failed kind=auth_failed step=git_push',
    )
  })

  it('does not leak secrets or content via generic known keys', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.error('backup_failed', {
      kind: 'pat ghp_AAAAAAAAA',
      step: '/tmp/clone/notes/secret.md',
    })
    expect(lines[0]).toBe('level=error event=backup_failed')
  })

  it('allows the dedicated path field to identify a failing vault file, quoting values that contain spaces', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.error('backup_failed', { path: 'notes/inbox/My Note.md' })
    expect(lines[0]).toBe(
      'level=error event=backup_failed path="notes/inbox/My Note.md"',
    )
  })

  it('drops the path field when it contains control characters', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.error('backup_failed', { path: 'notes/\n.md' })
    expect(lines[0]).toBe('level=error event=backup_failed')
  })

  it('drops the path field when it exceeds the length limit', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.error('backup_failed', { path: 'a'.repeat(513) })
    expect(lines[0]).toBe('level=error event=backup_failed')
  })

  it('sanitizes unsafe event names', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.info('path /tmp/foo/bar')
    expect(lines[0]).toBe('level=info event=event')
  })
})
