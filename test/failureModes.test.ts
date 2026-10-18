import { getEventListeners } from 'node:events'

import { afterEach, describe, expect, test } from 'vitest'

import { withResponseDeadline } from '../src/errors.ts'
import {
  CachedFilehandle,
  MAX_CONCURRENT,
  MAX_SIZE_ENTRIES,
  RemoteFileWithRangeCache,
  clearCache,
  clearCacheFor,
} from '../src/index.ts'
import { assertReadArgs, parseContentRange } from '../src/util.ts'

import type { GenericFilehandle } from 'generic-filehandle2'

const BLOCK = 256 * 1024
const FILE_SIZE = 2 * 1024 * 1024
// Each test gets its own origin. The cache is module-global and the request
// pool is keyed by origin, so a test that deliberately leaves a file stalled
// would otherwise hand the next test a pool with no free slots — which is the
// behaviour under test, not a flake.
let urlCounter = 0
function nextUrl() {
  urlCounter++
  return `https://f${urlCounter}.example.com/data.bin`
}

const fileData = new Uint8Array(FILE_SIZE)
for (let i = 0; i < FILE_SIZE; i++) {
  fileData[i] = i % 256
}

function requestedRange(init?: RequestInit) {
  const match = /bytes=(\d+)-(\d+)/.exec(
    new Headers(init?.headers).get('range') ?? '',
  )
  if (!match) {
    throw new Error('no range header')
  }
  return { start: Number(match[1]), end: Number(match[2]) }
}

/** a well-behaved server: 206 with an honest Content-Range, 416 past EOF */
function goodServer(log?: { start: number; end: number }[]) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const { start, end: asked } = requestedRange(init)
    const end = Math.min(asked, FILE_SIZE - 1)
    log?.push({ start, end })
    if (start >= FILE_SIZE) {
      return new Response('', {
        status: 416,
        headers: { 'content-range': `bytes */${FILE_SIZE}` },
      })
    }
    return new Response(fileData.slice(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${FILE_SIZE}` },
    })
  }
}

function makeFile(url: string, fetchImpl: unknown) {
  return new RemoteFileWithRangeCache(url, {
    fetch: fetchImpl as typeof globalThis.fetch,
  })
}

afterEach(() => {
  clearCache()
})

describe('a response that is not the range it claims to be', () => {
  test('a truncated body is rejected rather than cached as an early EOF', async () => {
    // a proxy that cuts every body short while still declaring the full range
    const truncating = async (_url: unknown, init?: RequestInit) => {
      const { start, end: asked } = requestedRange(init)
      const end = Math.min(asked, FILE_SIZE - 1)
      return new Response(fileData.slice(start, start + 1000), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${FILE_SIZE}` },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, truncating)
    await expect(file.read(100, 0)).rejects.toThrow(/truncated/)
  })

  test('and leaves nothing behind, so a recovered server serves the read', async () => {
    let truncate = true
    const flaky = async (url: unknown, init?: RequestInit) => {
      if (!truncate) {
        return goodServer()(url as string, init)
      }
      const { start, end } = requestedRange(init)
      return new Response(fileData.slice(start, start + 1000), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${Math.min(end, FILE_SIZE - 1)}/${FILE_SIZE}`,
        },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, flaky)
    await expect(file.read(100, 5000)).rejects.toThrow(/truncated/)
    truncate = false
    const bytes = await file.read(100, 5000)
    expect(bytes.length).toBe(100)
    expect([...bytes.slice(0, 4)]).toEqual([...fileData.slice(5000, 5004)])
  })

  test('a body describing some other range is rejected', async () => {
    // a cache answering with whatever range it had lying around
    const wrongRange = async (_url: unknown, init?: RequestInit) => {
      const { start, end } = requestedRange(init)
      const length = Math.min(end, FILE_SIZE - 1) - start + 1
      return new Response(fileData.slice(0, length), {
        status: 206,
        headers: { 'content-range': `bytes 0-${length - 1}/${FILE_SIZE}` },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, wrongRange)
    await expect(file.read(100, BLOCK * 3)).rejects.toThrow(
      /does not describe the range that was asked for/,
    )
  })

  test('a server that caps the length of a range is rejected, not short-read', async () => {
    // the shape a CDN or proxy with a maximum range size has: honest about the
    // range it served, silently short against the range that was asked for
    const capped = async (_url: unknown, init?: RequestInit) => {
      const { start, end: asked } = requestedRange(init)
      const end = Math.min(asked, start + 1024 * 1024 - 1, FILE_SIZE - 1)
      return new Response(fileData.slice(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${FILE_SIZE}` },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, capped)
    // both the offset and the declared length check out; only the request says
    // otherwise, which is why `end` has to reach assertBodyMatchesRange
    await expect(file.read(1536 * 1024, 0)).rejects.toThrow(
      /stops short of both the end asked for and the end of the file/,
    )
  })

  test('a range longer than the one asked for is fine', async () => {
    // a server aligning to its own block size; the extra bytes are sliced off
    const generous = async (_url: unknown, init?: RequestInit) => {
      const { start } = requestedRange(init)
      const end = Math.min(start + 4 * BLOCK - 1, FILE_SIZE - 1)
      return new Response(fileData.slice(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${FILE_SIZE}` },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, generous)
    const bytes = await file.read(100, 0)
    expect([...bytes.slice(0, 4)]).toEqual([...fileData.slice(0, 4)])
  })

  test('a rejected response does not get to fix the size of the file', async () => {
    // the total is as wrong as the body; recording it before the check let it
    // clamp every later read, and stat(), for the life of the process
    let bad = true
    const wrongTotal = async (url: unknown, init?: RequestInit) => {
      if (!bad) {
        return goodServer()(url as string, init)
      }
      const { start } = requestedRange(init)
      return new Response(fileData.slice(start, start + 10), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${start + 99}/4096` },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, wrongTotal)
    await expect(file.read(100, 0)).rejects.toThrow(/stops short/)
    bad = false
    expect((await file.read(100, 100_000)).length).toBe(100)
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
  })

  test('a body that runs past its own range is stopped at the length it declared', async () => {
    // the header is honest and the body is not, which the length check below
    // has always caught — but only once the whole of it was in memory. A proxy
    // streaming the file behind a correct `bytes 0-262143/...` held 8 MB for a
    // 262144-byte request before saying so
    const PIECE = 32 * 1024
    const state = { pulled: 0 }
    const overrunning = async (_url: unknown, init?: RequestInit) => {
      const { start, end } = requestedRange(init)
      const body = new ReadableStream(
        {
          pull(controller) {
            controller.enqueue(
              fileData.slice(state.pulled, state.pulled + PIECE),
            )
            state.pulled += PIECE
            if (state.pulled >= FILE_SIZE) {
              controller.close()
            }
          },
        },
        new CountQueuingStrategy({ highWaterMark: 0 }),
      )
      return new Response(body, {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${FILE_SIZE}` },
      })
    }
    const file = makeFile(nextUrl(), overrunning)
    await expect(file.read(100, 0)).rejects.toThrow(
      /runs past its own Content-Range/,
    )
    // the range asked for, plus the piece that overran it and proved there was
    // more coming
    expect(state.pulled).toBeLessThanOrEqual(BLOCK + 2 * PIECE)
  })

  test.each([
    ['no readable Content-Range', {}],
    [
      'a Content-Encoding',
      { 'content-range': `bytes 0-${BLOCK - 1}/${FILE_SIZE}` },
      'gzip',
    ],
  ])(
    'a body with %s that runs on is refused, read only as far as the request',
    async (_label, headers, encoding?: string) => {
      // a proxy streaming the whole file costs the request, not the file
      const PIECE = 32 * 1024
      const state = { pulled: 0 }
      const streaming = async () => {
        const body = new ReadableStream(
          {
            pull(controller) {
              controller.enqueue(
                fileData.slice(state.pulled, state.pulled + PIECE),
              )
              state.pulled += PIECE
              if (state.pulled >= FILE_SIZE) {
                controller.close()
              }
            },
          },
          new CountQueuingStrategy({ highWaterMark: 0 }),
        )
        const response = new Response(body, { status: 206, headers })
        if (encoding) {
          // a real Response decodes a gzip body, so set the header afterwards
          response.headers.set('content-encoding', encoding)
        }
        return response
      }
      const file = makeFile(nextUrl(), streaming)
      await expect(file.read(100, 0)).rejects.toThrow(/sent more than/)
      expect(state.pulled).toBeLessThanOrEqual(BLOCK + 2 * PIECE)
    },
  )

  test('a Response-like with no body stream is read through arrayBuffer', async () => {
    // a custom fetch may hand back an object with no `body`; read as a stream,
    // it came back empty and fixed the file's size at 0
    const responseLike = async () => ({
      status: 206,
      ok: true,
      headers: new Headers({ 'content-range': 'bytes 0-0/100' }),
      arrayBuffer: async () => fileData.slice(0, 1).buffer,
    })
    const file = makeFile(nextUrl(), responseLike)
    expect(await file.stat()).toEqual({ size: 100 })
  })

  test('a short body is accepted where the file really does end there', async () => {
    const url = nextUrl()
    const file = makeFile(url, goodServer())
    const bytes = await file.read(BLOCK, FILE_SIZE - 10)
    expect(bytes.length).toBe(10)
  })

  test('an encoded body is checked like any other', async () => {
    // the bytes of a range of an encoded file are not bytes of the file
    const encoded = async (_url: unknown, init?: RequestInit) => {
      const { start, end } = requestedRange(init)
      return new Response(fileData.slice(start, start + 50), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${Math.min(end, FILE_SIZE - 1)}/${FILE_SIZE}`,
          'content-encoding': 'gzip',
        },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, encoded)
    await expect(file.read(100, 0)).rejects.toThrow(/truncated/)
  })

  test('and against the range asked for', async () => {
    const encodedWrongRange = async (_url: unknown, init?: RequestInit) => {
      const { start } = requestedRange(init)
      return new Response(fileData.slice(start, start + 50), {
        status: 206,
        headers: {
          'content-range': `bytes 0-${BLOCK - 1}/${FILE_SIZE}`,
          'content-encoding': 'gzip',
        },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, encodedWrongRange)
    await expect(file.read(100, BLOCK * 3)).rejects.toThrow(
      /does not describe the range that was asked for/,
    )
  })

  test('a range that ends past the length it reports is rejected', async () => {
    // and rejected before its total reaches the size cache, which only ever
    // shrinks
    const impossible = async (_url: unknown, init?: RequestInit) => {
      const { start, end } = requestedRange(init)
      return new Response(
        fileData.slice(start, Math.min(end, FILE_SIZE - 1) + 1),
        {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${end}/100` },
        },
      )
    }
    const url = nextUrl()
    const file = makeFile(url, impossible)
    await expect(file.read(100, 0)).rejects.toThrow(/contradicts itself/)
    // nothing was learned from it, so the size is not fixed at 100 and a read
    // past that offset still reaches the server
    const recovered = makeFile(url, goodServer())
    expect((await recovered.read(1000, 200)).length).toBe(1000)
    expect(await recovered.stat()).toEqual({ size: FILE_SIZE })
  })

  test('a range that ends before it starts is rejected', async () => {
    const backwards = async (_url: unknown, init?: RequestInit) => {
      const { start } = requestedRange(init)
      return new Response(fileData.slice(start, start + 100), {
        status: 206,
        headers: {
          'content-range': `bytes ${start + 500}-${start}/${FILE_SIZE}`,
        },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, backwards)
    await expect(file.read(100, 0)).rejects.toThrow(/contradicts itself/)
  })

  test('no Content-Range means nothing to check against', async () => {
    const bare = async (_url: unknown, init?: RequestInit) => {
      const { start, end } = requestedRange(init)
      return new Response(
        fileData.slice(start, Math.min(end, FILE_SIZE - 1) + 1),
        { status: 206 },
      )
    }
    const url = nextUrl()
    const file = makeFile(url, bare)
    expect((await file.read(100, 0)).length).toBe(100)
  })
})

describe('EOF with no Content-Range to confirm it', () => {
  // A cross-origin server that does not expose Content-Range leaves the size
  // unknown. A short body or a 416 still has to bound it, or every read past
  // EOF asks again, and every bgzf reader over-reads its last block by
  // construction.
  const B_SIZE = 2 * BLOCK

  function noContentRange(calls: { n: number }) {
    return async (_url: unknown, init?: RequestInit) => {
      const { start, end: asked } = requestedRange(init)
      calls.n++
      if (start >= B_SIZE) {
        return new Response('', { status: 416 })
      }
      return new Response(
        fileData.slice(start, Math.min(asked, B_SIZE - 1) + 1),
        {
          status: 206,
        },
      )
    }
  }

  test('the empty tail of a run that returned data is cached as EOF', async () => {
    const calls = { n: 0 }
    const url = nextUrl()
    const file = makeFile(url, noContentRange(calls))
    expect((await file.read(3 * BLOCK, 0)).length).toBe(B_SIZE)
    const afterFirst = calls.n
    await file.read(3 * BLOCK, 0)
    await file.read(3 * BLOCK, 0)
    expect(calls.n).toBe(afterFirst)
  })

  test('a bare 416 bounds the file at its start, and is asked once', async () => {
    const calls = { n: 0 }
    const file = makeFile(nextUrl(), noContentRange(calls))
    expect((await file.read(100, B_SIZE + 10)).length).toBe(0)
    expect((await file.read(100, B_SIZE + 10)).length).toBe(0)
    expect((await file.read(100, B_SIZE + 50)).length).toBe(0)
    expect(calls.n).toBe(1)
    expect((await file.read(100, 0)).length).toBe(100)
  })
})

describe('a 416 reports where the file ends', () => {
  test('a 416 that reports the size is trusted, and asked only once', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    expect((await file.read(100, FILE_SIZE + BLOCK)).length).toBe(0)
    const afterFirst = log.length
    expect((await file.read(100, FILE_SIZE + BLOCK)).length).toBe(0)
    expect(log.length).toBe(afterFirst)
  })

  test('a 416 whose own size says the range exists is an error, not an EOF', async () => {
    let calls = 0
    const contradictory = async (url: unknown, init?: RequestInit) => {
      calls++
      return calls === 1
        ? new Response('', {
            status: 416,
            headers: { 'content-range': `bytes */${FILE_SIZE}` },
          })
        : goodServer()(url as string, init)
    }
    const url = nextUrl()
    const file = makeFile(url, contradictory)
    await expect(file.read(100, BLOCK)).rejects.toMatchObject({ status: 416 })
    // nothing from the refusal was kept
    expect((await file.read(100, BLOCK)).length).toBe(100)
  })

  test('and the size it reported is what stat answers with', async () => {
    const url = nextUrl()
    const file = makeFile(url, goodServer())
    await file.read(100, FILE_SIZE + BLOCK)
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
  })
})

describe('concurrency is scoped per origin', () => {
  test('a server that never answers does not block another one', async () => {
    const urlA = nextUrl()
    const urlB = nextUrl()
    const stalled = async (url: string | URL | Request, init?: RequestInit) => {
      if (typeof url === 'string' && url === urlA) {
        // headers never arrive and the request never settles
        return new Promise<Response>(() => {})
      }
      return goodServer()(url, init)
    }
    const fileA = makeFile(urlA, stalled)
    const fileB = makeFile(urlB, stalled)
    // saturate A's pool several times over
    for (let i = 0; i < 40; i++) {
      void fileA.read(10, i * BLOCK).catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    const bytes = await Promise.race([
      fileB.read(10, 0),
      new Promise<'blocked'>(resolve => {
        setTimeout(() => {
          resolve('blocked')
        }, 1500)
      }),
    ])
    expect(bytes).not.toBe('blocked')
  })

  test('an abort reaches a read still waiting for a slot', async () => {
    // the deadline does not cover this: it starts once the slot is claimed, so
    // behind a wedged origin a queued read waited forever and ignored its
    // caller entirely
    const origin = `https://q${urlCounter++}.example.com`
    const silent = (async () => new Promise<Response>(() => {})) as unknown
    const wedge = []
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      wedge.push(
        makeFile(`${origin}/wedge-${i}.bin`, silent)
          .read(10, 0)
          .catch(() => undefined),
      )
    }
    await Promise.resolve()

    const controller = new AbortController()
    const queued = makeFile(`${origin}/queued.bin`, silent).read(10, 0, {
      signal: controller.signal,
    })
    controller.abort(new Error('the view navigated away'))
    await expect(queued).rejects.toThrow('the view navigated away')
  })

  test('and the slot it was waiting for is not lost with it', async () => {
    // runNext claims a slot before resuming whatever it shifts, so a waiter
    // left behind as a no-op would take one out of the pool for good
    const origin = `https://q${urlCounter++}.example.com`
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const held = (async (url: unknown, init?: RequestInit) => {
      await gate
      return goodServer()(url as string, init)
    }) as unknown

    const first = []
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      first.push(makeFile(`${origin}/held-${i}.bin`, held).read(10, 0))
    }
    await Promise.resolve()

    const controller = new AbortController()
    const abandoned = makeFile(`${origin}/abandoned.bin`, held).read(10, 0, {
      signal: controller.signal,
    })
    controller.abort(new Error('gone'))
    await expect(abandoned).rejects.toThrow('gone')

    release!()
    await Promise.all(first)
    // the pool has all its slots back: another full batch runs to completion
    const second = []
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      second.push(
        makeFile(`${origin}/after-${i}.bin`, goodServer()).read(10, 0),
      )
    }
    expect((await Promise.all(second)).every(b => b.length === 10)).toBe(true)
  })

  test('clearCache() does not let the next reads overshoot the cap', async () => {
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let concurrent = 0
    let peak = 0
    const gated = async (url: string | URL | Request, init?: RequestInit) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await gate
      concurrent--
      return goodServer()(url, init)
    }
    const url = nextUrl()
    const file = makeFile(url, gated)
    for (let i = 0; i < 20; i++) {
      void file.read(10, i * BLOCK).catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    clearCache()
    for (let i = 0; i < 40; i++) {
      void file.read(10, (100 + i) * BLOCK).catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    expect(peak).toBeLessThanOrEqual(20)
  })
})

describe('the pool is keyed on the origin, not the URL', () => {
  test('a re-signed URL does not mint itself a fresh set of slots', async () => {
    let concurrent = 0
    let peak = 0
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const gated = async (url: string | URL | Request, init?: RequestInit) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      await gate
      concurrent--
      return goodServer()(url, init)
    }
    const base = nextUrl()
    // the shape a presigned URL has: same object, new signature every read
    const reads = Array.from({ length: 60 }, (_, i) =>
      makeFile(`${base}?sig=${i}`, gated)
        .read(10, i * BLOCK)
        .catch(() => {}),
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(peak).toBeLessThanOrEqual(20)
    release()
    await Promise.all(reads)
  })

  test('a different origin gets its own slots', async () => {
    const stalledOrigin = 'https://stalled.example.com/f.bin'
    const stalled = async (url: string | URL | Request, init?: RequestInit) => {
      if (typeof url === 'string' && url.startsWith('https://stalled.')) {
        return new Promise<Response>(() => {})
      }
      return goodServer()(url, init)
    }
    for (let i = 0; i < 40; i++) {
      void makeFile(stalledOrigin, stalled)
        .read(10, i * BLOCK)
        .catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    const other = makeFile(nextUrl(), stalled)
    const bytes = await Promise.race([
      other.read(10, 0),
      new Promise<'blocked'>(resolve => {
        setTimeout(() => {
          resolve('blocked')
        }, 1500)
      }),
    ])
    expect(bytes).not.toBe('blocked')
  })
})

describe('stat is shared between callers that ask at once', () => {
  test('ten concurrent stats make one request', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    const sizes = await Promise.all(
      Array.from({ length: 10 }, () => file.stat()),
    )
    expect(sizes.every(s => s.size === FILE_SIZE)).toBe(true)
    expect(log.length).toBe(1)
  })

  test('a failed stat is not remembered as in flight', async () => {
    let fail = true
    const flaky = async (url: unknown, init?: RequestInit) => {
      if (fail) {
        return new Response('', { status: 500 })
      }
      return goodServer()(url as string, init)
    }
    const url = nextUrl()
    const file = makeFile(url, flaky)
    await expect(file.stat()).rejects.toThrow(/HTTP 500/)
    fail = false
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
  })
})

describe('the response deadline lets go of the caller signal', () => {
  test('composing adds no listener to the caller signal', () => {
    const { signal } = new AbortController()
    const deadline = withResponseDeadline(signal, () => 'timed out')
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    deadline.stop()
  })

  test('cancellation still reaches the socket after the headers arrive', () => {
    const controller = new AbortController()
    const deadline = withResponseDeadline(controller.signal, () => 'timed out')
    // headers are in, the body is still streaming
    deadline.stop()
    controller.abort(new Error('reader gave up'))
    expect(deadline.signal.aborted).toBe(true)
  })

  test('a caller who already gave up gets an aborted signal', () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    const deadline = withResponseDeadline(controller.signal, () => 'timed out')
    expect(deadline.signal.aborted).toBe(true)
    deadline.stop()
  })
})

describe('read arguments that would become a wrong request', () => {
  test.for([
    ['negative position', 100, -1000],
    ['negative length', -100, 0],
    ['fractional position', 100, 10.5],
    ['fractional length', 10.5, 0],
    ['unsafe integer', 100, Number.MAX_SAFE_INTEGER + 2],
  ] as const)('%s is rejected', ([, length, position]) => {
    expect(() => {
      assertReadArgs('f.bin', length, position)
    }).toThrow(/non-negative safe-integer/)
  })

  test('NaN keeps its own message', () => {
    expect(() => {
      assertReadArgs('f.bin', Number.NaN, 0)
    }).toThrow(/NaN length or position/)
  })

  test('a Range header asking for more than a read may is refused', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    await expect(
      file.fetch(url, { headers: { range: 'bytes=0-99999999999999' } }),
    ).rejects.toThrow(/more than the .* a Uint8Array can hold/)
    expect(log).toEqual([])
  })

  test('a negative position never reaches the network', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    await expect(file.read(100, -1000)).rejects.toThrow(TypeError)
    expect(log).toEqual([])
  })
})

describe('parseContentRange', () => {
  test.for([
    ['bytes 0-255/12345', { start: 0, end: 255, total: 12345 }],
    ['bytes */12345', { start: undefined, end: undefined, total: 12345 }],
    ['bytes 0-255/*', { start: 0, end: 255, total: undefined }],
    ['  bytes 0-255/12345  ', { start: 0, end: 255, total: 12345 }],
  ] as const)('parses %s', ([header, expected]) => {
    expect(parseContentRange(header)).toEqual(expected)
  })

  test.for([null, '', 'bytes 0-255', 'items 0-255/12345', 'bytes 0-255/'])(
    'rejects %s',
    header => {
      expect(parseContentRange(header)).toBeUndefined()
    },
  )

  // A header this malformed cannot be checked a response against, so start and
  // end stay undefined and validation skips. The total is still worth having:
  // without it stat() reports the loss as a CORS misconfiguration, pointing at
  // a header that arrived and was simply not parsed.
  test.for([
    // a real server bug: `=` where the grammar has a space
    'bytes=0-255/12345',
    // Headers.get joins a duplicated header with a comma
    'bytes 0-255/12345, bytes 0-255/12345',
    'bytes 0/12345',
  ])('recovers only the total from %s', header => {
    expect(parseContentRange(header)).toEqual({
      start: undefined,
      end: undefined,
      total: 12345,
    })
  })
})

describe('clearCacheFor', () => {
  test('drops one file and leaves the others', async () => {
    const logA: { start: number; end: number }[] = []
    const logB: { start: number; end: number }[] = []
    const urlA = nextUrl()
    const urlB = nextUrl()
    const fileA = makeFile(urlA, goodServer(logA))
    const fileB = makeFile(urlB, goodServer(logB))
    await fileA.read(100, 0)
    await fileB.read(100, 0)
    clearCacheFor(urlA)
    await fileA.read(100, 0)
    await fileB.read(100, 0)
    expect({ a: logA.length, b: logB.length }).toEqual({ a: 2, b: 1 })
  })

  test('leaves a key that merely starts the same alone', async () => {
    // chunk keys are `${key}:${index}`, so a prefix test alone also matches
    // every chunk of a key that begins with this one — host:port URLs and
    // timestamped object names are ordinary
    const logA: { start: number; end: number }[] = []
    const logB: { start: number; end: number }[] = []
    const urlA = nextUrl()
    const urlB = `${urlA}:2024`
    const fileA = makeFile(urlA, goodServer(logA))
    const fileB = makeFile(urlB, goodServer(logB))
    await fileA.read(100, 0)
    await fileB.read(100, 0)
    clearCacheFor(urlA)
    await fileA.read(100, 0)
    await fileB.read(100, 0)
    expect({ a: logA.length, b: logB.length }).toEqual({ a: 2, b: 1 })
  })

  test('a request already in flight does not put the file back afterwards', async () => {
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const slow = async (u: string | URL | Request, init?: RequestInit) => {
      await gate
      return goodServer(log)(u, init)
    }
    const file = makeFile(url, slow)
    const first = file.read(100, 0)
    await new Promise(resolve => setTimeout(resolve, 10))
    clearCacheFor(url)
    release()
    await first
    await file.read(100, 0)
    // the in-flight run served its own reader, then stayed out of the cache
    expect(log.length).toBe(2)
  })

  // A file rewritten in place, longer. The server answers with the length the
  // file had when the request arrived, and holds the answer until `release`.
  function growingFile() {
    const file = { size: BLOCK, release: () => {} }
    const gate = new Promise<void>(resolve => {
      file.release = resolve
    })
    const fetchImpl = async (_url: unknown, init?: RequestInit) => {
      const size = file.size
      await gate
      const { start, end: asked } = requestedRange(init)
      const end = Math.min(asked, size - 1)
      return new Response(fileData.slice(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${size}` },
      })
    }
    return { file, fetchImpl }
  }

  test('a read in flight does not put the old size back afterwards', async () => {
    const url = nextUrl()
    const { file: served, fetchImpl } = growingFile()
    const file = makeFile(url, fetchImpl)
    const first = file.read(100, 0)
    await new Promise(resolve => setTimeout(resolve, 10))
    served.size = FILE_SIZE
    clearCacheFor(url)
    served.release()
    await first
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
    expect((await file.read(100, 2 * BLOCK)).length).toBe(100)
  })

  test('a stat in flight does not put the old size back afterwards', async () => {
    const url = nextUrl()
    const { file: served, fetchImpl } = growingFile()
    const file = makeFile(url, fetchImpl)
    const first = file.stat()
    await new Promise(resolve => setTimeout(resolve, 10))
    served.size = FILE_SIZE
    clearCacheFor(url)
    served.release()
    // asked before the clear, so it gets the answer to what it asked
    expect(await first).toEqual({ size: BLOCK })
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
  })

  test('drops the size it learned, so stat asks again', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    await file.stat()
    clearCacheFor(url)
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
    expect(log.length).toBe(2)
  })
})

describe('a subclass that knows the size from somewhere else', () => {
  test('recordSize clamps reads without any range request finding out', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    // the shape a cloud provider's metadata endpoint takes: stat answers from
    // somewhere the chunk cache never sees
    class FromMetadata extends RemoteFileWithRangeCache {
      override async stat() {
        this.recordSize(FILE_SIZE)
        return { size: FILE_SIZE }
      }
    }
    const file = new FromMetadata(url, {
      fetch: goodServer(log),
    })
    await file.stat()
    expect(log).toEqual([])
    // the over-read every bgzf reader does on its last block, clamped by a
    // size no range request ever observed
    expect((await file.read(BLOCK, FILE_SIZE - 10)).length).toBe(10)
    expect(log.every(r => r.start < FILE_SIZE)).toBe(true)
  })
})

describe('the size cache is bounded', () => {
  // The clamp is the observable. A key whose size is known answers a read past
  // the end without going to the source at all; once it has been evicted the
  // same read reaches through. Asserting on `stat()` instead proves nothing —
  // it answers from the inner filehandle either way.
  function sized(size: number, reads: number[]) {
    return {
      read: async (length: number, position: number) => {
        reads.push(position)
        return new Uint8Array(length)
      },
      readFile: async () => new Uint8Array(0),
      stat: async () => ({ size }),
      close: async () => {},
    } as unknown as GenericFilehandle
  }

  test('a rotating key evicts the oldest, and the evicted one loses its clamp', async () => {
    const reads: number[] = []
    const inner = sized(1000, reads)
    const stable = new CachedFilehandle(inner, 'stable')
    await stable.stat()
    expect((await stable.read(100, 1_000_000)).length).toBe(0)
    expect(reads).toEqual([])

    for (let i = 0; i < MAX_SIZE_ENTRIES + 100; i++) {
      await new CachedFilehandle(inner, `signed-url-${i}`).stat()
    }

    // 'stable' was written before all of them, so it is gone and the clamp with
    // it; the read now reaches the source
    expect((await stable.read(100, 1_000_000)).length).toBe(100)
    expect(reads).toEqual([1_000_000])
  })

  test('a size still being used is not evicted by rotation around it', async () => {
    const reads: number[] = []
    const inner = sized(1000, reads)
    const stable = new CachedFilehandle(inner, 'stable')
    await stable.stat()
    for (let i = 0; i < MAX_SIZE_ENTRIES + 100; i++) {
      await new CachedFilehandle(inner, `signed-url-${i}`).stat()
      if (i % 100 === 0) {
        // a read is what keeps it alive; eviction order is by use, not by write
        await stable.read(100, 1_000_000)
      }
    }
    expect((await stable.read(100, 1_000_000)).length).toBe(0)
    expect(reads).toEqual([])
  })
})

describe('the bytes a read hands back', () => {
  test('a short read owns its buffer rather than viewing a longer one', async () => {
    // a view would carry the whole requested length behind it, so transferring
    // `.buffer` — which every worker pool over these bytes does — would move
    // bytes past the end of the read
    const url = nextUrl()
    const file = makeFile(url, goodServer())
    const bytes = await file.read(1000, FILE_SIZE - 100)
    expect(bytes.length).toBe(100)
    expect(bytes.buffer.byteLength).toBe(100)
  })

  test('a full read is handed back without a copy', async () => {
    const url = nextUrl()
    const file = makeFile(url, goodServer())
    const bytes = await file.read(1000, 0)
    expect(bytes.length).toBe(1000)
    expect(bytes.buffer.byteLength).toBe(1000)
  })
})

describe('the options a handle was constructed with', () => {
  // read() does not go through RemoteFile.buildRequest, which is where the base
  // class merges these in. Left to the per-call options alone, every range
  // request went out unauthenticated and no constructor signal cancelled
  // anything — with nothing said either way.
  function capture(seen: RequestInit[]) {
    return async (_url: unknown, init?: RequestInit) => {
      seen.push(init ?? {})
      const { start, end } = requestedRange(init)
      return new Response(
        fileData.slice(start, Math.min(end, FILE_SIZE - 1) + 1),
        {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${Math.min(end, FILE_SIZE - 1)}/${FILE_SIZE}`,
          },
        },
      )
    }
  }

  test('a constructor header reaches a range request', async () => {
    const seen: RequestInit[] = []
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: capture(seen),
      headers: { authorization: 'Bearer token' },
    })
    await file.read(100, 0)
    expect(new Headers(seen[0]!.headers).get('authorization')).toBe(
      'Bearer token',
    )
  })

  test('a per-call header wins over the constructor one', async () => {
    const seen: RequestInit[] = []
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: capture(seen),
      headers: { authorization: 'Bearer base', 'x-trace': 'kept' },
    })
    await file.read(100, 0, { headers: { authorization: 'Bearer call' } })
    const headers = new Headers(seen[0]!.headers)
    expect(headers.get('authorization')).toBe('Bearer call')
    expect(headers.get('x-trace')).toBe('kept')
  })

  test('constructor overrides reach a range request', async () => {
    const seen: RequestInit[] = []
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: capture(seen),
      overrides: { credentials: 'include' },
    })
    await file.read(100, 0)
    expect(seen[0]!.credentials).toBe('include')
  })

  test('a constructor signal cancels a read', async () => {
    const seen: RequestInit[] = []
    const controller = new AbortController()
    controller.abort(new Error('the track closed'))
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: capture(seen),
      signal: controller.signal,
    })
    await expect(file.read(100, 0)).rejects.toThrow('the track closed')
    expect(seen).toEqual([])
  })

  test('a per-call signal beats one supplied through overrides', async () => {
    // RemoteFile.buildRequest applies the signal last, after `overrides`, so
    // `opts.signal` wins. This class had the spread the other way round, which
    // let an overrides-supplied signal cancel a read whose caller had given it a
    // live one.
    const seen: RequestInit[] = []
    const stale = new AbortController()
    stale.abort(new Error('overrides should not win'))
    const file = new RemoteFileWithRangeCache(nextUrl(), {
      fetch: capture(seen),
    })
    const live = new AbortController()
    const bytes = await file.read(100, 0, {
      signal: live.signal,
      overrides: { signal: stale.signal },
    })
    expect(bytes.length).toBe(100)
  })
})

// A server with no range support answers a range request with 200 and the
// whole file. Reading that body allocates all of it, so the status is checked
// before a byte is read.
describe('a server that ignores Range and sends the whole file', () => {
  const PIECE = 32 * 1024

  /** a 200 whose body reports how much of it was actually pulled */
  function wholeFileServer(headers: HeadersInit = {}) {
    const state = { pulled: 0, requests: 0 }
    const fetchImpl = async () => {
      state.requests++
      const body = new ReadableStream(
        {
          pull(controller) {
            controller.enqueue(
              fileData.slice(state.pulled, state.pulled + PIECE),
            )
            state.pulled += PIECE
            if (state.pulled >= FILE_SIZE) {
              controller.close()
            }
          },
        },
        // a default queuing strategy pulls the moment the stream is
        // constructed, whether or not anything ever reads it, which would have
        // this reporting a download that never happened
        new CountQueuingStrategy({ highWaterMark: 0 }),
      )
      return new Response(body, { status: 200, headers })
    }
    return { state, fetchImpl }
  }

  // a 200 is refused at the status, before its body is read
  const CEILING = 0

  test('a read is refused, holding no more than the range it asked for', async () => {
    const { state, fetchImpl } = wholeFileServer()
    const file = makeFile(nextUrl(), fetchImpl)
    await expect(file.read(100, 0)).rejects.toThrow(/ignored the Range header/)
    expect(state.pulled).toBeLessThanOrEqual(CEILING)
  })

  test('so does stat, rather than downloading the file to count it', async () => {
    const { state, fetchImpl } = wholeFileServer()
    const file = makeFile(nextUrl(), fetchImpl)
    await expect(file.stat()).rejects.toThrow(/ignored the Range header/)
    expect(state.pulled).toBeLessThanOrEqual(CEILING)
  })

  test('and does not blame a Content-Range that was never the problem', async () => {
    const { fetchImpl } = wholeFileServer()
    const file = makeFile(nextUrl(), fetchImpl)
    // the header is there and readable; range support is what is missing, and
    // sending the reader after Access-Control-Expose-Headers wastes their day
    await expect(file.stat()).rejects.toThrow(/byte-range support is required/)
  })

  test('a Content-Length is not taken for the size of the file', async () => {
    // the cross-origin gzip case: Content-Encoding is not CORS-safelisted, so
    // the browser hides it while showing a Content-Length that counts
    // compressed bytes. Trusting it recorded a 2 MB file as 64 KiB — and reads
    // past that point were then clamped away to nothing and returned empty
    const { fetchImpl } = wholeFileServer({ 'content-length': '65536' })
    const file = makeFile(nextUrl(), fetchImpl)
    await expect(file.stat()).rejects.toThrow(/ignored the Range header/)
  })

  test('a failure with no size in it is still the failure the caller needs', async () => {
    const file = makeFile(
      nextUrl(),
      async () => new Response('', { status: 404 }),
    )
    // not flattened into "Content-Range was not readable", which would send a
    // reader after a CORS header when the file simply is not there
    await expect(file.stat()).rejects.toThrow(/404/)
  })
})

describe('a server that answers with no length in it at all', () => {
  test('stat names the CORS header and the other cause both', async () => {
    // `bytes 0-0/*` is a readable header from a correctly configured server
    // that has simply declined to give a total. Being told to expose a header
    // it already exposes sends the reader after nothing
    const file = makeFile(
      nextUrl(),
      async () =>
        new Response(fileData.slice(0, 1), {
          status: 206,
          headers: { 'content-range': 'bytes 0-0/*' },
        }),
    )
    const error = await file.stat().catch((e: unknown) => e)
    expect(String(error)).toMatch(/Access-Control-Expose-Headers/)
    expect(String(error)).toMatch(/declined to say how long the file is/)
  })
})

describe('a read that starts past the end of the file', () => {
  const RAGGED = BLOCK + 1000

  function raggedServer(log: { start: number; end: number }[]) {
    return async (_url: string | URL | Request, init?: RequestInit) => {
      const { start, end: asked } = requestedRange(init)
      const end = Math.min(asked, RAGGED - 1)
      log.push({ start, end })
      return new Response(fileData.slice(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${RAGGED}` },
      })
    }
  }

  test('asks for nothing, having nothing to assemble', async () => {
    const log: { start: number; end: number }[] = []
    const file = makeFile(nextUrl(), raggedServer(log))
    await file.stat()
    log.length = 0
    expect(await file.read(100, RAGGED)).toHaveLength(0)
    expect(log).toEqual([])
  })

  test('including one well past it', async () => {
    const log: { start: number; end: number }[] = []
    const file = makeFile(nextUrl(), raggedServer(log))
    await file.stat()
    log.length = 0
    expect(await file.read(100, RAGGED + 500)).toHaveLength(0)
    expect(log).toEqual([])
  })

  test('a read that merely runs past the end is still served', async () => {
    const log: { start: number; end: number }[] = []
    const file = makeFile(nextUrl(), raggedServer(log))
    await file.stat()
    expect(await file.read(5000, RAGGED - 100)).toHaveLength(100)
  })
})

describe('a size nobody has stated', () => {
  // no Content-Range, and a 404 past EOF, as JBrowse's test server answers: a
  // request starting past the end fails the read rather than reading as EOF
  function strictServer(size: number, log: { start: number; end: number }[]) {
    const gates: (() => void)[] = []
    const fetchImpl = async (_url: unknown, init?: RequestInit) => {
      const { start, end } = requestedRange(init)
      log.push({ start, end })
      await new Promise<void>(resolve => gates.push(resolve))
      return start >= size
        ? new Response('', { status: 404 })
        : new Response(fileData.slice(start, Math.min(end + 1, size)), {
            status: 206,
          })
    }
    return {
      fetchImpl,
      release: () => {
        for (const gate of gates.splice(0)) {
          gate()
        }
      },
    }
  }

  test('a gap where a request in flight ends waits for it to find EOF', async () => {
    const size = 1_000_000
    const log: { start: number; end: number }[] = []
    const { fetchImpl, release } = strictServer(size, log)
    const file = makeFile(nextUrl(), fetchImpl)
    // two bgzf tail over-reads, planned in different turns
    const first = file.read(65_536, size - 2000)
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = file.read(95_536, size - 1500)
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    expect(await first).toEqual(fileData.slice(size - 2000, size))
    expect(await second).toEqual(fileData.slice(size - 1500, size))
    expect(log.every(({ start }) => start < size)).toBe(true)
  })

  test('and a gap past one that does not end the file is then fetched', async () => {
    const size = 1_000_000
    const log: { start: number; end: number }[] = []
    const { fetchImpl, release } = strictServer(size, log)
    const file = makeFile(nextUrl(), fetchImpl)
    const first = file.read(1000, 0)
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = file.read(200_000, 500)
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    await first
    const reading = second.then(bytes => bytes)
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    expect(await reading).toEqual(fileData.slice(500, 200_500))
  })

  test('stat does not answer with a bound a bare 416 implied', async () => {
    const size = 300_000
    const file = makeFile(
      nextUrl(),
      async (_url: unknown, init?: RequestInit) => {
        const { start, end } = requestedRange(init)
        return start >= size
          ? new Response('', { status: 416 })
          : new Response(fileData.slice(start, Math.min(end + 1, size)), {
              status: 206,
            })
      },
    )
    expect(await file.read(100, size + 5000)).toHaveLength(0)
    await expect(file.stat()).rejects.toThrow(/Could not determine size/)
  })
})

describe('a file rewritten larger', () => {
  test('a stat after the rewrite lifts the size a short body recorded', async () => {
    let size = 200_000
    const inner = {
      read: async (length: number, position: number) =>
        fileData.slice(position, Math.min(position + length, size)),
      readFile: async () => fileData.slice(0, size),
      stat: async () => ({ size, mtimeMs: size }),
      close: async () => {},
    } as unknown as GenericFilehandle
    const before = new CachedFilehandle(inner, 'file:///grows.bin')
    expect(await before.read(1000, 199_500)).toHaveLength(500)
    size = 400_000
    const after = new CachedFilehandle(inner, 'file:///grows.bin')
    expect(await after.stat()).toEqual({ size, mtimeMs: size })
    expect(await after.read(1000, 300_000)).toEqual(
      fileData.slice(300_000, 301_000),
    )
  })
})
