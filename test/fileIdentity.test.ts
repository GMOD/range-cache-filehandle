import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BlobFile, LocalFile, RemoteFile } from 'generic-filehandle2'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { hasSize } from '../src/chunkCache.ts'
import { CachedFilehandle, clearCache, clearCacheFor } from '../src/index.ts'

import type { GenericFilehandle, Stats } from 'generic-filehandle2'

const CHUNK = 256 * 1024
const dec = new TextDecoder()

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcf-identity-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  clearCache()
})

function rewrite(file: string, contents: string) {
  const before = fs.statSync(file).mtimeMs
  fs.writeFileSync(file, contents)
  const later = new Date(before + 5000)
  fs.utimesSync(file, later, later)
}

function countingInner(stat: () => Promise<Stats>, size = 4 * CHUNK) {
  const data = new Uint8Array(size).map((_, i) => i % 251)
  let reads = 0
  const inner: GenericFilehandle = {
    read(length: number, position: number) {
      reads++
      return Promise.resolve(data.slice(position, position + length))
    },
    readFile: (() => Promise.resolve(data)) as never,
    stat,
    close: () => Promise.resolve(),
  }
  return { inner, reads: () => reads }
}

describe('a local file rewritten in place', () => {
  test('a new handle reads the new bytes after a stat on the old one', async () => {
    const file = path.join(dir, 'p9.bin')
    fs.writeFileSync(file, 'AAAAAAAAAA')
    const h1 = new CachedFilehandle(new LocalFile(file), `file://${file}`)
    await h1.stat()
    expect(dec.decode(await h1.read(10, 0))).toBe('AAAAAAAAAA')

    rewrite(file, 'BBBBBBBBBBBBBBBBBBBB')
    const h2 = new CachedFilehandle(new LocalFile(file), `file://${file}`)
    expect(dec.decode(await h2.read(20, 0))).toBe('BBBBBBBBBBBBBBBBBBBB')
  })

  test('a new handle reads the new bytes, stat or no stat', async () => {
    const file = path.join(dir, 'm4.bin')
    fs.writeFileSync(file, 'AAAAAAAAAA')
    const h1 = new CachedFilehandle(new LocalFile(file), `file://${file}`)
    expect(dec.decode(await h1.read(10, 0))).toBe('AAAAAAAAAA')

    rewrite(file, 'BBBBBBBBBBBBBBBBBBBB')
    const h2 = new CachedFilehandle(new LocalFile(file), `file://${file}`)
    expect((await h2.stat()).size).toBe(20)
    expect(dec.decode(await h2.read(20, 0))).toBe('BBBBBBBBBBBBBBBBBBBB')
  })

  test('two handles on an unchanged file share chunks', async () => {
    const file = path.join(dir, 'shared.bin')
    fs.writeFileSync(file, new Uint8Array(CHUNK * 2))
    let reads = 0
    const counted = () => {
      const local = new LocalFile(file)
      const read = local.read.bind(local)
      local.read = (...args: Parameters<typeof read>) => {
        reads++
        return read(...args)
      }
      return local
    }
    await new CachedFilehandle(counted(), `file://${file}`).read(100, 0)
    await new CachedFilehandle(counted(), `file://${file}`).read(100, 0)
    expect(reads).toBe(1)
  })

  test('resolves its identity once per handle, not once per read', async () => {
    let stats = 0
    const { inner } = countingInner(() => {
      stats++
      return Promise.resolve({ size: 4 * CHUNK, mtimeMs: 1000.5, ino: 7 })
    })
    const file = new CachedFilehandle(inner, 'file:///data/once.bin')
    await Promise.all([file.read(10, 0), file.read(10, CHUNK)])
    for (let i = 0; i < 10; i++) {
      await file.read(10, i)
    }
    expect(stats).toBe(1)
  })
  test('a reader that aborts while the identity resolves gets its own reason', async () => {
    const { inner, reads } = countingInner(() => new Promise<never>(() => {}))
    const file = new CachedFilehandle(inner, 'file:///data/stalled-stat.bin')
    const controller = new AbortController()
    const mine = new Error('superseded')
    const read = file.read(10, 0, { signal: controller.signal })
    controller.abort(mine)
    await expect(read).rejects.toBe(mine)
    expect(reads()).toBe(0)
  })
})

describe('the cache key for a source without a modification time', () => {
  test('a Blob-backed handle keeps the caller’s key', async () => {
    const blob = new Blob([new Uint8Array(CHUNK * 2)])
    await new CachedFilehandle(new BlobFile(blob), 'blob://abc').read(100, 0)
    const other = countingInner(() => Promise.resolve({ size: CHUNK * 2 }))
    await new CachedFilehandle(other.inner, 'blob://abc').read(100, 0)
    expect(other.reads()).toBe(0)
  })

  test('a rejecting stat() falls back to the caller’s key', async () => {
    const failing = countingInner(() =>
      Promise.reject(new Error('stat failed')),
    )
    const first = new CachedFilehandle(failing.inner, 'file:///data/nostat.bin')
    expect((await first.read(100, 0)).length).toBe(100)
    expect(failing.reads()).toBe(1)

    const other = countingInner(() => Promise.resolve({ size: 4 * CHUNK }))
    await new CachedFilehandle(other.inner, 'file:///data/nostat.bin').read(
      100,
      0,
    )
    expect(other.reads()).toBe(0)
  })
})

describe('clearCacheFor with the caller’s key', () => {
  test('clears a handle keyed on its file identity, chunks and size', async () => {
    const stats = { size: 4 * CHUNK, mtimeMs: 1234.5, ino: 42 }
    const { inner, reads } = countingInner(() => Promise.resolve(stats))
    const file = new CachedFilehandle(inner, 'file:///data/x.bam')
    await file.read(10, 0)
    const identity = `file:///data/x.bam@42:1234.5:${4 * CHUNK}`
    expect(hasSize(identity)).toBe(true)

    clearCacheFor('file:///data/x.bam')
    expect(hasSize(identity)).toBe(false)
    await file.read(10, 0)
    expect(reads()).toBe(2)
  })

  test('leaves a file whose key merely begins with the same text', async () => {
    const stats = { size: 4 * CHUNK, mtimeMs: 1, ino: 1 }
    const a = countingInner(() => Promise.resolve(stats))
    const b = countingInner(() => Promise.resolve(stats))
    const fileA = new CachedFilehandle(a.inner, 'file:///data/a')
    const fileB = new CachedFilehandle(b.inner, 'file:///data/a@b')
    await fileA.read(10, 0)
    await fileB.read(10, 0)

    clearCacheFor('file:///data/a')
    await fileA.read(10, 0)
    await fileB.read(10, 0)
    expect(a.reads()).toBe(2)
    expect(b.reads()).toBe(1)
  })
})

describe('a size the stats cannot vouch for', () => {
  test('a remote size of 0 from hidden Content-Range does not empty the file', async () => {
    const body = new Uint8Array(1000).map((_, i) => i % 251)
    const fetch = (_url: string | URL | Request, init?: RequestInit) => {
      const m = /bytes=(\d+)-(\d+)/.exec(
        new Headers(init?.headers).get('range') ?? '',
      )!
      const start = Number(m[1])
      const end = Math.min(Number(m[2]), body.length - 1)
      return Promise.resolve(
        new Response(body.slice(start, end + 1), { status: 206 }),
      )
    }
    const viaStat = new CachedFilehandle(
      new RemoteFile('https://example.com/m2', { fetch }),
      'https://example.com/m2',
    )
    expect((await viaStat.stat()).size).toBe(0)
    expect((await viaStat.read(100, 0)).length).toBe(100)

    clearCache()
    const lazy = new CachedFilehandle(
      new RemoteFile('https://example.com/m2', { fetch }),
      'https://example.com/m2',
    )
    expect((await lazy.read(100, 0)).length).toBe(100)
  })

  test('a non-empty Blob’s size is recorded', async () => {
    const file = new CachedFilehandle(
      new BlobFile(new Blob(['abc'])),
      'blob://sized',
    )
    expect(dec.decode(await file.read(100, 0))).toBe('abc')
    expect(hasSize('blob://sized')).toBe(true)
  })

  test('an empty Blob reads as empty', async () => {
    const file = new CachedFilehandle(
      new BlobFile(new Blob([])),
      'blob://empty',
    )
    expect((await file.stat()).size).toBe(0)
    expect((await file.read(100, 0)).length).toBe(0)
  })

  test('an empty local file records its size and reads as empty', async () => {
    const file = path.join(dir, 'empty.bin')
    fs.writeFileSync(file, '')
    const { ino, mtimeMs } = fs.statSync(file)
    const handle = new CachedFilehandle(new LocalFile(file), `file://${file}`)
    expect((await handle.read(100, 0)).length).toBe(0)
    expect(hasSize(`file://${file}@${ino}:${mtimeMs}:0`)).toBe(true)
  })
})
