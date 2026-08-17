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
import { unrefIfPossible } from './util.ts'

export interface ResponseDeadline {
  /** what to hand `fetch`: the caller's signal and this deadline, composed */
  signal: AbortSignal
  /** the error to report, set once the deadline has fired */
  expired?: Error
  /** stop the clock; call as soon as the response headers arrive */
  responded: () => void
  /** unlink from the caller's signal; call once the request is over */
  dispose: () => void
}

/**
 * `signal`, plus a {@link RESPONSE_TIMEOUT_MS} deadline on the server beginning
 * to answer.
 *
 * **The caller's signal is composed, never replaced.** It is what carries
 * cancellation down to the socket and what the run's reference count aborts once
 * every reader has given up; handing `fetch` a deadline signal in its place
 * would silently take cancellation back off the socket, which is worth ~6.5 MiB
 * per cancelled navigation.
 *
 * Two disposers rather than one, because the two things being held have
 * different lifetimes. {@link ResponseDeadline.responded} stops the clock as
 * soon as the headers arrive, since from there the body may take as long as it
 * takes. {@link ResponseDeadline.dispose} unlinks from the caller's signal, and
 * cannot happen until the request is finished — unlink at the headers and a
 * caller aborting during the body would no longer reach the socket, which is
 * the leak this composition exists to prevent.
 *
 * **`dispose` is not optional, and this is the one place it matters.** A signal
 * holds its dependent signals weakly, so `AbortSignal.any` against a
 * session-long controller retains nothing — measured on node 24, all 20,000
 * composed signals were collected while their source stayed alive.
 * @see https://dom.spec.whatwg.org/#abortsignal-dependent-signals
 * An event listener is the opposite: the source holds it strongly, and none of
 * 20,000 were collected. So composing by hand, as this does, is the version
 * that leaks if it is not cleaned up, and `removeEventListener` is what makes
 * it safe.
 *
 * Hand-composed anyway for two reasons. It is one code path rather than
 * `AbortSignal.any` plus a fallback for consumers whose targets predate it
 * (Chrome 116, Firefox 124, Safari 17.4), where a missing static would be a
 * TypeError on every range request. And the lifetime has to be explicit here
 * regardless, because of the two-disposer split above.
 *
 * `describe` is a thunk so nothing builds the message unless the deadline fires.
 */
export function withResponseDeadline(
  signal: AbortSignal | null | undefined,
  describe: () => string,
) {
  const composed = new AbortController()
  const onCallerAbort = () => {
    composed.abort(signal?.reason)
    // Stand the deadline down with it. Once the caller has given up there is
    // nothing left for it to diagnose, and a `fetch` that does not honour the
    // signal reaches neither `responded` nor `dispose` — so the timer fires
    // half a minute later, writes `expired`, and `describeFetchFailure` prefers
    // it, reporting a cancelled request as a server that never answered.
    deadline.dispose()
  }
  const deadline: ResponseDeadline = {
    signal: composed.signal,
    responded: () => {
      clearTimeout(timer)
    },
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    },
  }
  if (signal?.aborted) {
    composed.abort(signal.reason)
  } else {
    signal?.addEventListener('abort', onCallerAbort)
  }
  const timer = setTimeout(() => {
    deadline.expired = new Error(describe())
    composed.abort(deadline.expired)
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
