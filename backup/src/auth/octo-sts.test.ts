import { describe, expect, it, vi } from 'vitest'

import {
  exchangeOctoStsToken,
  OctoStsAuthError,
  type OctoStsConfig,
  type OctoStsDeps,
} from '#auth/octo-sts'

const BASE_CONFIG: OctoStsConfig = {
  url: 'https://octo-sts.fohte.net',
  scope: 'fohte/obsidian-v2',
  identity: 'obsidian-livesync-backup',
  saTokenPath: '/var/run/secrets/tokens/octo-sts-token',
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const makeDeps = (): {
  deps: OctoStsDeps
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
  readFileMock: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>
} => {
  const fetchMock = vi.fn<typeof fetch>()
  const readFileMock = vi.fn<(path: string) => Promise<string>>(
    async () => 'sa-token',
  )
  return {
    deps: { fetch: fetchMock, readFile: readFileMock },
    fetchMock,
    readFileMock,
  }
}

describe('exchangeOctoStsToken', () => {
  it('exchanges the SA token for an installation token', async () => {
    const { deps, fetchMock, readFileMock } = makeDeps()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'gh-token' }))
    const result = await exchangeOctoStsToken(BASE_CONFIG, deps)
    expect(result._unsafeUnwrap()).toBe('gh-token')
    expect(readFileMock.mock.calls[0]).toEqual([BASE_CONFIG.saTokenPath])
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe(
      'https://octo-sts.fohte.net/sts/exchange?scope=fohte%2Fobsidian-v2&identity=obsidian-livesync-backup',
    )
    expect(init?.method).toBe('GET')
    expect(init?.headers).toEqual({
      authorization: 'Bearer sa-token',
      accept: 'application/json',
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns an OctoStsAuthError on a non-ok response', async () => {
    const { deps, fetchMock } = makeDeps()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: 'no trust policy' }),
    )
    const result = await exchangeOctoStsToken(BASE_CONFIG, deps)
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(OctoStsAuthError)
  })

  it('returns an OctoStsAuthError on a network error', async () => {
    const { deps, fetchMock } = makeDeps()
    fetchMock.mockRejectedValueOnce(new Error('socket hangup'))
    const result = await exchangeOctoStsToken(BASE_CONFIG, deps)
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(OctoStsAuthError)
  })

  it('returns an OctoStsAuthError when the response body is not JSON', async () => {
    const { deps, fetchMock } = makeDeps()
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    const result = await exchangeOctoStsToken(BASE_CONFIG, deps)
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(OctoStsAuthError)
  })

  it('returns an OctoStsAuthError when the response body is malformed', async () => {
    const { deps, fetchMock } = makeDeps()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { not_token: 'x' }))
    const result = await exchangeOctoStsToken(BASE_CONFIG, deps)
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(OctoStsAuthError)
  })

  it('returns an OctoStsAuthError when the SA token file cannot be read', async () => {
    const { deps, readFileMock } = makeDeps()
    readFileMock.mockRejectedValueOnce(new Error('ENOENT: no such file'))
    const result = await exchangeOctoStsToken(BASE_CONFIG, deps)
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(OctoStsAuthError)
  })

  it('returns an OctoStsAuthError when the SA token file is empty', async () => {
    const { deps, fetchMock, readFileMock } = makeDeps()
    readFileMock.mockResolvedValueOnce('   \n')
    const result = await exchangeOctoStsToken(BASE_CONFIG, deps)
    expect(result._unsafeUnwrapErr().message).toBe(
      'octo-sts exchange aborted: SA token at /var/run/secrets/tokens/octo-sts-token is empty',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
