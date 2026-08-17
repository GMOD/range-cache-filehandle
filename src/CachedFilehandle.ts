import { getCachedRange, recordSize } from './chunkCache.ts'
import { assertReadArgs } from './util.ts'

import type {
  FilehandleOptions,
  GenericFilehandle,
  ReadFileOptions,
  ReadFileTextOptions,
  Stats,
} from 'generic-filehandle2'

/**
 * The same chunk cache, in front of any filehandle.
 *
 * {@link RemoteFileWithRangeCache} gets its cache by *being* a `RemoteFile`, so
 * for as long as that was the only entry point, local paths and blobs got no
 * caching at all. Nothing in the cache is about HTTP, so this wraps whatever it
 * is given instead.
 *
 * `key` namespaces this file's chunks in the module-global cache, so it has to
 * identify the underlying bytes: a path or a URL for something with a stable
 * name, and something instance-unique for a Blob, which has no name to key on.
 * Two wrappers sharing a key share chunks, which is right for two handles on
 * one path and wrong for two unrelated blobs.
 */
export class CachedFilehandle implements GenericFilehandle {
  // explicit fields rather than constructor parameter properties, which node's
  // type stripper cannot erase — `erasableSyntaxOnly` bans them
  private inner: GenericFilehandle
  private key: string

  constructor(inner: GenericFilehandle, key: string) {
    this.inner = inner
    this.key = key
  }

  async read(
    length: number,
    position: number,
    opts: FilehandleOptions = {},
  ): Promise<Uint8Array<ArrayBuffer>> {
    assertReadArgs(this.key, length, position)
    if (length === 0) {
      return new Uint8Array(0)
    }
    return getCachedRange(
      this.key,
      position,
      length,
      opts.signal ? { signal: opts.signal } : undefined,
      (start, end, init) =>
        // everything the caller passed reaches the inner handle, since it may
        // be a filehandle for which `headers` and `overrides` mean something —
        // a RemoteFile, or one of its subclasses. Only the signal is replaced:
        // the request belongs to the run, which outlives any one reader of it
        this.inner.read(end - start + 1, start, {
          ...opts,
          ...(init?.signal ? { signal: init.signal } : {}),
        }),
    )
  }

  // Whole-file reads bypass the chunk cache: they are one pass over bytes the
  // caller is about to hold in full anyway, so chunking them would double the
  // peak for no reuse. This is what `RemoteFile.readFile` does too.
  readFile(options?: ReadFileOptions): Promise<Uint8Array<ArrayBuffer>>
  readFile(options: ReadFileTextOptions): Promise<string>
  readFile(
    options?: ReadFileOptions | ReadFileTextOptions,
  ): Promise<Uint8Array<ArrayBuffer> | string> {
    return this.inner.readFile(options as ReadFileOptions)
  }

  // annotated rather than inferred: the `--module commonjs` pass cannot name
  // `Stats` from the inferred type and fails the build (TS2883)
  async stat(): Promise<Stats> {
    const stats = await this.inner.stat()
    // lets getCachedRange clamp reads that run past EOF, which every bgzf
    // reader does by construction on its last block
    recordSize(this.key, stats.size)
    return stats
  }

  close() {
    return this.inner.close()
  }
}
