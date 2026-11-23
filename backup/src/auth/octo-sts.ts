import { readFile } from 'node:fs/promises'

import { errAsync, okAsync, ResultAsync } from 'neverthrow'

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
}

const EXCHANGE_TIMEOUT_MS = 10_000

export class OctoStsAuthError extends Error {
  override readonly name = 'OctoStsAuthError'
}

export const exchangeOctoStsToken = (
  config: OctoStsConfig,
  deps: OctoStsDeps = {},
): ResultAsync<string, OctoStsAuthError> => {
  const fetchImpl = deps.fetch ?? fetch
  const readFileImpl = deps.readFile ?? ((path) => readFile(path, 'utf-8'))

  return ResultAsync.fromPromise(readFileImpl(config.saTokenPath), (cause) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    return new OctoStsAuthError(
      `octo-sts exchange failed to read SA token at ${config.saTokenPath}: ${message}`,
    )
  })
    .andThen((rawToken) => {
      const saToken = rawToken.trim()
      if (saToken === '') {
        return errAsync(
          new OctoStsAuthError(
            `octo-sts exchange aborted: SA token at ${config.saTokenPath} is empty`,
          ),
        )
      }
      return okAsync(saToken)
    })
    .andThen((saToken) => {
      const url = new URL('/sts/exchange', config.url)
      url.searchParams.set('scope', config.scope)
      url.searchParams.set('identity', config.identity)

      return ResultAsync.fromPromise(
        fetchImpl(url.toString(), {
          method: 'GET',
          headers: {
            authorization: `Bearer ${saToken}`,
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        }),
        (cause) => {
          const message = cause instanceof Error ? cause.message : String(cause)
          return new OctoStsAuthError(
            `octo-sts exchange network error: ${message}`,
          )
        },
      )
    })
    .andThen((res) => {
      if (!res.ok) {
        return errAsync(
          new OctoStsAuthError(
            `octo-sts exchange failed: HTTP ${String(res.status)}`,
          ),
        )
      }
      return ResultAsync.fromPromise(
        res.json(),
        () => new OctoStsAuthError('octo-sts exchange returned non-JSON body'),
      )
    })
    .andThen((json) => {
      if (!isExchangeResponse(json)) {
        return errAsync(
          new OctoStsAuthError('octo-sts exchange returned malformed body'),
        )
      }
      return okAsync(json.token)
    })
}

const isExchangeResponse = (value: unknown): value is ExchangeResponse =>
  typeof value === 'object' &&
  value !== null &&
  'token' in value &&
  typeof value.token === 'string'
