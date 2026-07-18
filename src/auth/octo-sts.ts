import { readFile } from 'node:fs/promises'

export interface OctoStsConfig {
  readonly url: string
  readonly scope: string
  readonly identity: string
  readonly saTokenPath: string
}

export interface OctoStsDeps {
  readonly fetch?: typeof fetch
  readonly readFile?: (path: string) => Promise<string>
}

interface ExchangeResponse {
  token: string
  expires_at: string
}

const EXCHANGE_TIMEOUT_MS = 10_000

export class OctoStsAuthError extends Error {
  override readonly name = 'OctoStsAuthError'
}

export const exchangeOctoStsToken = async (
  config: OctoStsConfig,
  deps: OctoStsDeps = {},
): Promise<string> => {
  const fetchImpl = deps.fetch ?? fetch
  const readFileImpl = deps.readFile ?? ((path) => readFile(path, 'utf-8'))

  const saToken = (await readFileImpl(config.saTokenPath)).trim()
  if (saToken === '') {
    throw new OctoStsAuthError(
      `octo-sts exchange aborted: SA token at ${config.saTokenPath} is empty`,
    )
  }

  const url = new URL('/sts/exchange', config.url)
  url.searchParams.set('scope', config.scope)
  url.searchParams.set('identity', config.identity)

  let res: Response
  try {
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${saToken}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new OctoStsAuthError(`octo-sts exchange network error: ${message}`)
  }

  if (!res.ok) {
    throw new OctoStsAuthError(
      `octo-sts exchange failed: HTTP ${String(res.status)}`,
    )
  }

  const json: unknown = await res.json()
  if (!isExchangeResponse(json)) {
    throw new OctoStsAuthError('octo-sts exchange returned malformed body')
  }
  return json.token
}

const isExchangeResponse = (value: unknown): value is ExchangeResponse =>
  typeof value === 'object' &&
  value !== null &&
  'token' in value &&
  typeof value.token === 'string' &&
  'expires_at' in value &&
  typeof value.expires_at === 'string'
