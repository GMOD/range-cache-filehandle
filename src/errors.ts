/**
 * Failing legibly.
 *
 * The status path is the good example here — the 416, the "server ignored the
 * Range header" hint, the Content-Range note `stat()` throws — and the two gaps
 * it left were the request that gets no status at all and the request that gets
 * no answer at all. Everything in this module is about those two.
 *
 * Deliberately no retry: a failed range read surfaces as an error and the
 * reader decides.
 */
import { RESPONSE_TIMEOUT_MS } from './constants.ts'
import { anySignal, unrefIfPossible } from './util.ts'

export interface ResponseDeadline {
  /** what to hand `fetch`: the caller's signal and this deadline, composed */
  signal: AbortSignal
  /** the error to report, set once the deadline has fired */
  expired?: Error
  /** stop the clock; call as soon as a response arrives */
  dispose: () => void
}

/**
 * `signal`, plus a {@link RESPONSE_TIMEOUT_MS} deadline on the server beginning
 * to answer, and the disposer that stops that clock.
 *
 * **The caller's signal is composed, never replaced.** It is what carries
 * cancellation down to the socket and what the run's reference count aborts once
 * every reader has given up; handing `fetch` a deadline signal in its place
 * would silently take cancellation back off the socket, which is worth ~6.5 MiB
 * per cancelled navigation.
 *
 * `describe` is a thunk so nothing builds the message unless the deadline fires.
 */
export function withResponseDeadline(
  signal: AbortSignal | null | undefined,
  describe: () => string,
) {
  const timeout = new AbortController()
  const deadline: ResponseDeadline = {
    signal: signal ? anySignal(signal, timeout.signal) : timeout.signal,
    dispose: () => {
      clearTimeout(timer)
    },
  }
  const timer = setTimeout(() => {
    deadline.expired = new Error(describe())
    timeout.abort(deadline.expired)
  }, RESPONSE_TIMEOUT_MS)
  // a deadline still pending must not hold a node process open, same reasoning
  // as the sweep interval
  unrefIfPossible(timer)
  return deadline
}

/**
 * Whether a rejection is a network-level one — the request never reached a
 * response, so there is no status and no headers, only a `TypeError`.
 *
 * Checked down the `cause` chain rather than on the rejection itself, because
 * `RemoteFile.fetch` catches that TypeError first and rethrows
 * `new Error(`${message} fetching ${url}`, { cause: e })` (and, on Chrome's
 * exact "Failed to fetch" wording, retries once through the cache to work around
 * a Chrome CORS-cache bug). By the time it gets here the class is gone and the
 * chain is the only thing that still says what it was. Depth-bounded because a
 * cause chain is not guaranteed acyclic.
 */
export function isNetworkRejection(e: unknown) {
  let cause = e
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    if (cause instanceof TypeError) {
      return true
    }
    cause = cause.cause
  }
  return false
}

/**
 * A https page may not load a http file, and the browser blocks it before it is
 * sent — one of the two causes of a bare network rejection that is checkable
 * from inside the page.
 */
function isMixedContent(url: string) {
  if (typeof location === 'undefined' || location.protocol !== 'https:') {
    return false
  }
  try {
    return new URL(url, location.href).protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * What to tell someone whose request never reached a response.
 *
 * A CORS denial, a mixed-content block, a DNS failure, a refused connection and
 * an offline browser all arrive as the same bare TypeError — `Failed to fetch`
 * in Chrome, `Load failed` in Safari, `NetworkError when attempting to fetch
 * resource` in Firefox — with no status, no headers and no URL. The browser
 * withholds the difference deliberately, since an error that named the cause
 * would itself be a cross-origin read. So this names the two that are checkable
 * from here and then the one that is left, which is also the one that is nearly
 * always right for a genome file on someone else's server.
 */
export function networkFailureHint(url: string) {
  // `=== false`, not `!onLine`. Node has had a global `navigator` since 21 and
  // it has no `onLine` at all, so the falsy test reported every network failure
  // under node as "no network connection" — swallowing the CORS triage below,
  // which is the part worth reading. jbrowse only ever ran this in a browser or
  // in jsdom, where the property is always there.
  //
  // eslint reads the comparison as redundant because the DOM lib types `onLine`
  // as a plain boolean. That type is what is wrong here, not the comparison.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return ' (the browser reports no network connection)'
  } else if (isMixedContent(url)) {
    return ' (a page served over https may not load a file served over http, and the browser blocked this before it left; the file has to be served over https too)'
  } else {
    return ' (no response at all, so there is no status to report — most often CORS: the server must send Access-Control-Allow-Origin, and Access-Control-Expose-Headers: Content-Range as well or the size of the file cannot be read either. A host that is down, a DNS failure and a blocked port look identical from here)'
  }
}

/**
 * What a reader can do about a status, appended to the message carrying it.
 * Only for the statuses where there is something to say; anything else gets the
 * number, the URL and the byte range, which is already more than `fetch` gives.
 */
export function statusHint(status: number) {
  if (status === 200) {
    return ' (the server ignored the Range header and returned the whole file; byte-range support is required for BAM/CRAM/tabix/bigwig files)'
  } else if (status === 401 || status === 403) {
    return ' (the file is there and the request was refused; a signed URL may have expired, or a bucket policy may not grant read to the page origin)'
  } else if (status === 404) {
    return ' (no such file; check the URL, and that the index file sits where the reader expects it alongside the data file)'
  } else if (status === 429 || status >= 500) {
    return ' (the server is failing or declining to serve this file just now; nothing is retried automatically, so try again once it recovers)'
  } else {
    return ''
  }
}
