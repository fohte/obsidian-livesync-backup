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
