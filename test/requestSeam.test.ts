import { afterEach, describe, expect, test } from 'vitest'

import { RemoteFileWithRangeCache, clearCache } from '../src/index.ts'

const FILE_SIZE = 4096

let urlCounter = 0
function nextUrl() {
  urlCounter++
  return `https://seam${urlCounter}.example.com/data.bin`
}

function capture(seen: RequestInit[]) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {})
    const match = /bytes=(\d+)-(\d+)/.exec(
      new Headers(init?.headers).get('range') ?? '',
    )
    const start = Number(match?.[1] ?? 0)
    const end = Math.min(Number(match?.[2] ?? 0), FILE_SIZE - 1)
    return new Response(new Uint8Array(end - start + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${FILE_SIZE}` },
    })
  }
}

afterEach(() => {
  clearCache()
})

describe('requests go through RemoteFile.buildRequest', () => {
  test('stat() carries the constructor headers and overrides', async () => {
    const seen: RequestInit[] = []
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: capture(seen),
      headers: { authorization: 'Bearer token' },
      overrides: { credentials: 'include' },
    })
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
    expect(seen).toHaveLength(1)
    expect(new Headers(seen[0]!.headers).get('authorization')).toBe(
      'Bearer token',
    )
    expect(seen[0]!.credentials).toBe('include')
  })

  test('a per-call authorization replaces a constructor Authorization', async () => {
    const seen: RequestInit[] = []
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: capture(seen),
      headers: { Authorization: 'Bearer base' },
    })
    await file.read(100, 0, { headers: { authorization: 'Bearer call' } })
    expect(new Headers(seen[0]!.headers).get('authorization')).toBe(
      'Bearer call',
    )
  })

  test('read(0, -1) still throws', async () => {
    const seen: RequestInit[] = []
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: capture(seen),
    })
    await expect(file.read(0, -1)).rejects.toThrow(TypeError)
    expect(seen).toEqual([])
  })

  test('a length past what a Uint8Array holds is refused', async () => {
    const seen: RequestInit[] = []
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: capture(seen),
    })
    await expect(file.read(2 ** 32, 0)).rejects.toThrow(/a Uint8Array can hold/)
    expect(seen).toEqual([])
  })
})
