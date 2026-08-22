export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  log(
    level: LogLevel,
    event: string,
    fields?: Readonly<Record<string, number | string>>,
  ): void
  info(event: string, fields?: Readonly<Record<string, number | string>>): void
  warn(event: string, fields?: Readonly<Record<string, number | string>>): void
  error(event: string, fields?: Readonly<Record<string, number | string>>): void
}

export interface LoggerSink {
  write(line: string): void
}

const SAFE_FIELD_KEYS = new Set([
  'count',
  'fetched',
  'written',
  'excluded',
  'masked',
  'duration_ms',
  'kind',
  'step',
  'committed',
  'snapshot_at',
])

const isSafeValue = (v: number | string): boolean => {
  if (typeof v === 'number') return Number.isFinite(v)
  // strings: bounded length, no slashes/newlines/spaces/colons that hint at paths or secrets
  return v.length <= 32 && /^[a-z0-9_-]+$/i.test(v)
}

// `path` is a deliberate, narrow exception to the "no slashes/paths" rule
// above: it exists solely to name the vault file behind a backup failure
// (e.g. a missing-chunk error), the same path that would otherwise end up
// committed into the backup git repository. It still rejects control
// characters (which would break the single-line format) and oversized
// values, and quotes the result like logfmt so paths containing spaces
// don't get misread as extra fields.
const PATH_FIELD_KEY = 'path'
const MAX_PATH_LENGTH = 512

const isSafePathValue = (v: number | string): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= MAX_PATH_LENGTH &&
  !/[\x00-\x1f\x7f]/.test(v)

const quotePathValue = (v: string): string =>
  `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export class SafeLogger implements Logger {
  constructor(
    private readonly sink: LoggerSink = {
      write: (l) => process.stdout.write(`${l}\n`),
    },
  ) {}

  log(
    level: LogLevel,
    event: string,
    fields: Readonly<Record<string, number | string>> = {},
  ): void {
    const safeEvent = /^[a-z][a-z0-9_]*$/.test(event) ? event : 'event'
    const parts: string[] = [`level=${level}`, `event=${safeEvent}`]
    for (const [k, v] of Object.entries(fields)) {
      if (k === PATH_FIELD_KEY) {
        if (!isSafePathValue(v)) continue
        parts.push(`${k}=${quotePathValue(v)}`)
        continue
      }
      if (!SAFE_FIELD_KEYS.has(k)) continue
      if (!isSafeValue(v)) continue
      parts.push(`${k}=${String(v)}`)
    }
    this.sink.write(parts.join(' '))
  }

  info(
    event: string,
    fields?: Readonly<Record<string, number | string>>,
  ): void {
    this.log('info', event, fields)
  }

  warn(
    event: string,
    fields?: Readonly<Record<string, number | string>>,
  ): void {
    this.log('warn', event, fields)
  }

  error(
    event: string,
    fields?: Readonly<Record<string, number | string>>,
  ): void {
    this.log('error', event, fields)
  }
}
