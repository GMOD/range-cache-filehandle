import { getEventListeners } from 'node:events'

import { afterEach, describe, expect, test } from 'vitest'

import { CachedFilehandle, clearCache } from '../src/index.ts'

import type { FilehandleOptions, GenericFilehandle } from 'generic-filehandle2'

const CHUNK = 256 * 1024
const FILE_SIZE = 4 * CHUNK
const fileData = new Uint8Array(FILE_SIZE).map((_, i) => i % 251)

function heldInner() {
  const held: { release: () => void; fail: (e: Error) => void }[] = []
  let reads = 0
  const inner: GenericFilehandle = {
    read(length: number, position: number, opts: FilehandleOptions = {}) {
      reads++
      return new Promise((resolve, reject) => {
        const { signal } = opts
        signal?.addEventListener(
          'abort',
          () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(signal.reason)
          },
          { once: true },
        )
        held.push({
          release: () => {
            resolve(fileData.slice(position, position + length))
          },
          fail: reject,
        })
      })
    },
    readFile: (() => Promise.resolve(fileData)) as never,
    stat: () => Promise.resolve({ size: FILE_SIZE }),
    close: () => Promise.resolve(),
  }
  return { inner, held, reads: () => reads }
}

function track(p: Promise<unknown>) {
  const outcome: { state: string; value?: unknown } = { state: 'pending' }
  p.then(
    value => {
      outcome.state = 'resolved'
      outcome.value = value
    },
    (e: unknown) => {
      outcome.state = 'rejected'
      outcome.value = e
    },
  )
  return outcome
}

function expectRejectedWith(
  outcome: { state: string; value?: unknown },
  reason: unknown,
) {
  expect(outcome.state).toBe('rejected')
  expect(outcome.value).toBe(reason)
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => {
  clearCache()
})

describe('a reader that gives up on a shared run', () => {
  test('is released at once with its own reason while another reader holds the run', async () => {
    const { inner, held, reads } = heldInner()
    const file = new CachedFilehandle(inner, 'file:///tmp/abort-a.bin')
    const a = new AbortController()
    const mine = new Error('superseded')
    const readA = track(file.read(100, 0, { signal: a.signal }))
    const readB = track(file.read(100, 0))
    await tick()

    a.abort(mine)
    await tick()
    expectRejectedWith(readA, mine)
    expect(readB.state).toBe('pending')

    held.forEach(h => {
      h.release()
    })
    await tick()
    expect(readB.state).toBe('resolved')
    expect([...(readB.value as Uint8Array)]).toEqual([
      ...fileData.slice(0, 100),
    ])
    expect(reads()).toBe(1)
  })

  test('two readers that both abort each receive their own reason', async () => {
    const { inner } = heldInner()
    const file = new CachedFilehandle(inner, 'file:///tmp/abort-b.bin')
    const a = new AbortController()
    const b = new AbortController()
    const reasonA = new Error('a gave up')
    const reasonB = new Error('b gave up')
    const readA = track(file.read(100, 0, { signal: a.signal }))
    const readB = track(file.read(100, 0, { signal: b.signal }))
    await tick()

    a.abort(reasonA)
    b.abort(reasonB)
    await tick()
    expectRejectedWith(readA, reasonA)
    expectRejectedWith(readB, reasonB)
  })

  test('a run that fails after one reader left rejects only the reader still waiting', async () => {
    const { inner, held } = heldInner()
    const file = new CachedFilehandle(inner, 'file:///tmp/abort-c.bin')
    const a = new AbortController()
    const b = new AbortController()
    const mine = new Error('superseded')
    const readA = track(file.read(100, 0, { signal: a.signal }))
    const readB = track(file.read(100, 0, { signal: b.signal }))
    await tick()

    a.abort(mine)
    const failure = new Error('disk went away')
    held.forEach(h => {
      h.fail(failure)
    })
    await tick()
    expectRejectedWith(readA, mine)
    expectRejectedWith(readB, failure)
  })

  test('leaves no listeners on a long-lived signal after many reads', async () => {
    const { inner, held } = heldInner()
    const file = new CachedFilehandle(inner, 'file:///tmp/abort-d.bin')
    const signal = new AbortController().signal
    for (let round = 0; round < 25; round++) {
      clearCache()
      const reads = [0, 1, 2, 3].map(i =>
        file.read(100, i * CHUNK + round, { signal }),
      )
      await tick()
      held.splice(0).forEach(h => {
        h.release()
      })
      await Promise.all(reads)
      await file.read(100, round, { signal })
    }
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })
})
