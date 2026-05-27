import { describe, expect, it } from 'vitest'

import { ExcludeFilter } from '@/exclude'

describe('ExcludeFilter path rules', () => {
  const filter = new ExcludeFilter({
    paths: ['custom/**', '*.bak'],
    secretPatterns: [],
  })

  it.each([
    '.obsidian/plugins/obsidian-livesync/data.json',
    '.trash/note.md',
    '.trash/deep/inner.md',
    'foo/bar.tmp',
    'custom/anything.md',
    'random.bak',
  ])('excludes %s', (path) => {
    expect(filter.isPathExcluded(path)).toBe(true)
  })

  it.each([
    '.obsidian/app.json',
    '.obsidian/plugins/other/data.json',
    'notes/inbox.md',
    'attachments/image.png',
  ])('keeps %s', (path) => {
    expect(filter.isPathExcluded(path)).toBe(false)
  })
})

describe('ExcludeFilter content scan', () => {
  it('returns content unchanged when no patterns configured', () => {
    const filter = new ExcludeFilter({ paths: [], secretPatterns: [] })
    const r = filter.scanContent('hello sk-abc123 world')
    expect(r.content).toBe('hello sk-abc123 world')
    expect(r.maskedCount).toBe(0)
  })

  it('masks matches and counts them', () => {
    const filter = new ExcludeFilter({
      paths: [],
      secretPatterns: ['sk-[A-Za-z0-9]+'],
    })
    const r = filter.scanContent('a sk-abc b sk-xyz c')
    expect(r.content).toBe('a ***REDACTED*** b ***REDACTED*** c')
    expect(r.maskedCount).toBe(2)
  })
})
