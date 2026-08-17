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

const CHUNK = 256 * 1024
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
    await expect(file.read(100, CHUNK * 3)).rejects.toThrow(
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
      const end = Math.min(start + 4 * CHUNK - 1, FILE_SIZE - 1)
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
    await expect(file.read(100, 0)).rejects.toThrow(/truncated/)
    bad = false
    expect((await file.read(100, 100_000)).length).toBe(100)
    expect(await file.stat()).toEqual({ size: FILE_SIZE })
  })

  test('a short body is accepted where the file really does end there', async () => {
    const url = nextUrl()
    const file = makeFile(url, goodServer())
    const bytes = await file.read(CHUNK, FILE_SIZE - 10)
    expect(bytes.length).toBe(10)
  })

  test('an encoded body is not checked, since its length is not the range', async () => {
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
    await expect(file.read(100, 0)).resolves.toBeInstanceOf(Uint8Array)
  })

  test('but an encoded body is still checked against the range asked for', async () => {
    // the length checks have to be skipped here; the offset one does not, and
    // skipping it along with them made one added header enough to walk a
    // truncated body past every check and into the cache as an early EOF
    const encodedWrongRange = async (_url: unknown, init?: RequestInit) => {
      const { start } = requestedRange(init)
      return new Response(fileData.slice(start, start + 50), {
        status: 206,
        headers: {
          'content-range': `bytes 0-${CHUNK - 1}/${FILE_SIZE}`,
          'content-encoding': 'gzip',
        },
      })
    }
    const url = nextUrl()
    const file = makeFile(url, encodedWrongRange)
    await expect(file.read(100, CHUNK * 3)).rejects.toThrow(
      /does not describe the range that was asked for/,
    )
  })

  test('a range that ends past the length it reports is rejected', async () => {
    // and rejected before recordSizeIfUnknown sees it: the total is what fixes
    // the size of the file for every handle on the URL
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
  // unknown, so isKnownPastEof can never fire. The empty chunk past the end
  // still has to be cached, or every read past EOF asks again — permanently,
  // and every bgzf reader over-reads its last block by construction.
  const B_SIZE = 2 * CHUNK

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
    // the file is an exact multiple of CHUNK, so there is no short chunk to
    // stop at — only the empty one past it
    expect((await file.read(3 * CHUNK, 0)).length).toBe(B_SIZE)
    const afterFirst = calls.n
    await file.read(3 * CHUNK, 0)
    await file.read(3 * CHUNK, 0)
    expect(calls.n).toBe(afterFirst)
  })

  test('but a run that came back wholly empty is still not believed', async () => {
    let calls = 0
    const url = nextUrl()
    // no content-range, no body, nothing that says this range was past the end
    const file = makeFile(url, async () => {
      calls++
      return new Response('', { status: 416 })
    })
    expect((await file.read(100, 0)).length).toBe(0)
    expect((await file.read(100, 0)).length).toBe(0)
    expect(calls).toBe(2)
  })
})

describe('416 that explains nothing is answered but not remembered', () => {
  test('a spurious 416 does not poison the chunk for later reads', async () => {
    let calls = 0
    const flaky416 = async (url: unknown, init?: RequestInit) => {
      calls++
      // no content-range, so nothing confirms this range was past the end
      return calls === 1
        ? new Response('', { status: 416 })
        : goodServer()(url as string, init)
    }
    const url = nextUrl()
    const file = makeFile(url, flaky416)
    expect((await file.read(100, 0)).length).toBe(0)
    // previously served 0 bytes from cache forever; now it asks again
    expect((await file.read(100, 0)).length).toBe(100)
  })

  test('a 416 that reports the size is trusted, and asked only once', async () => {
    const log: { start: number; end: number }[] = []
    const url = nextUrl()
    const file = makeFile(url, goodServer(log))
    expect((await file.read(100, FILE_SIZE + CHUNK)).length).toBe(0)
    const afterFirst = log.length
    expect((await file.read(100, FILE_SIZE + CHUNK)).length).toBe(0)
    expect(log.length).toBe(afterFirst)
  })

  test('and the size it reported is what stat answers with', async () => {
    const url = nextUrl()
    const file = makeFile(url, goodServer())
    await file.read(100, FILE_SIZE + CHUNK)
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
      void fileA.read(10, i * CHUNK).catch(() => {})
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
      void file.read(10, i * CHUNK).catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    clearCache()
    for (let i = 0; i < 40; i++) {
      void file.read(10, (100 + i) * CHUNK).catch(() => {})
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
        .read(10, i * CHUNK)
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
        .read(10, i * CHUNK)
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
  test('dispose removes the listener it added', () => {
    const controller = new AbortController()
    let added = 0
    let removed = 0
    const { signal } = controller
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      added++
      add(...args)
    }
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      removed++
      remove(...args)
    }
    const deadline = withResponseDeadline(signal, () => 'timed out')
    expect(added).toBe(1)
    deadline.responded()
    expect(removed).toBe(0)
    deadline.dispose()
    expect(removed).toBe(1)
  })

  test('cancellation still reaches the socket after the headers arrive', () => {
    const controller = new AbortController()
    const deadline = withResponseDeadline(controller.signal, () => 'timed out')
    // headers are in, the body is still streaming
    deadline.responded()
    controller.abort(new Error('reader gave up'))
    expect(deadline.signal.aborted).toBe(true)
  })

  test('a caller who already gave up gets an aborted signal', () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    const deadline = withResponseDeadline(controller.signal, () => 'timed out')
    expect(deadline.signal.aborted).toBe(true)
    deadline.dispose()
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
    // parseByteRange takes any pair of digits, and planRead walks one iteration
    // and one in-flight entry per CHUNK_SIZE of the length before its first
    // await: measured, this range spent 112 seconds there and then took the
    // process out with a heap OOM rather than ever reaching the network
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
    expect((await file.read(CHUNK, FILE_SIZE - 10)).length).toBe(10)
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
    expect(reads).toEqual([3 * CHUNK])
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
