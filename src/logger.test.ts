import { describe, expect, it } from 'vitest'

import { SafeLogger } from '@/logger'

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
      path: 'notes/secret.md',
      content: 'plaintext',
    })
    expect(lines[0]).toBe('level=info event=fetch_done fetched=1')
  })

  it('does not leak secrets, paths, or content even via known keys', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.error('backup_failed', {
      kind: 'auth_failed',
      step: 'git_push',
    })
    // string values are validated and only safe shapes are kept
    expect(lines[0]).toContain('kind=auth_failed')
    expect(lines[0]).toContain('step=git_push')

    lines.length = 0
    logger.error('backup_failed', {
      kind: 'pat ghp_AAAAAAAAA',
      step: '/tmp/clone/notes/secret.md',
    })
    expect(lines[0]).toBe('level=error event=backup_failed')
  })

  it('sanitizes unsafe event names', () => {
    const { sink, lines } = collect()
    const logger = new SafeLogger(sink)
    logger.info('path /tmp/foo/bar')
    expect(lines[0]).toBe('level=info event=event')
  })
})
