import { describe, expect, it, vi } from 'vitest'

import {
  exchangeOctoStsToken,
  OctoStsAuthError,
  type OctoStsConfig,
  type OctoStsDeps,
} from '@/auth/octo-sts'

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
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        token: 'gh-token',
        expires_at: '2026-07-18T01:00:00Z',
      }),
    )
    expect(await exchangeOctoStsToken(BASE_CONFIG, deps)).toBe('gh-token')
    expect(readFileMock).toHaveBeenCalledWith(BASE_CONFIG.saTokenPath)
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe(
      'https://octo-sts.fohte.net/sts/exchange?scope=fohte%2Fobsidian-v2&identity=obsidian-livesync-backup',
    )
    const headers = new Headers(call?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer sa-token')
  })

  it('throws OctoStsAuthError on a non-ok response', async () => {
    const { deps, fetchMock } = makeDeps()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: 'no trust policy' }),
    )
    await expect(exchangeOctoStsToken(BASE_CONFIG, deps)).rejects.toThrow(
      OctoStsAuthError,
    )
  })

  it('throws OctoStsAuthError on a network error', async () => {
    const { deps, fetchMock } = makeDeps()
    fetchMock.mockRejectedValueOnce(new Error('socket hangup'))
    await expect(exchangeOctoStsToken(BASE_CONFIG, deps)).rejects.toThrow(
      OctoStsAuthError,
    )
  })

  it('throws OctoStsAuthError when the response body is malformed', async () => {
    const { deps, fetchMock } = makeDeps()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'only' }))
    await expect(exchangeOctoStsToken(BASE_CONFIG, deps)).rejects.toThrow(
      OctoStsAuthError,
    )
  })

  it('throws OctoStsAuthError when the SA token file is empty', async () => {
    const { deps, fetchMock, readFileMock } = makeDeps()
    readFileMock.mockResolvedValueOnce('   \n')
    await expect(exchangeOctoStsToken(BASE_CONFIG, deps)).rejects.toThrow(
      /SA token at .* is empty/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes an AbortSignal to fetch for the exchange timeout', async () => {
    const { deps, fetchMock } = makeDeps()
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        token: 'tok',
        expires_at: '2026-07-18T01:00:00Z',
      }),
    )
    await exchangeOctoStsToken(BASE_CONFIG, deps)
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})
