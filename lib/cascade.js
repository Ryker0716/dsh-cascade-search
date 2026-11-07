/**
 * The cascade engine — pure logic, no DeepSeek Harness imports.
 *
 * Keeping this module dependency-free is deliberate: it can be unit-tested with
 * plain `node --test`, without booting a Harness profile. The Cordis plugin
 * wrapper lives in `./index.js`.
 *
 * Backend order is data, not code: {@link CASCADE_BACKENDS} holds the three
 * search backends and {@link CascadeSearchProvider} walks whichever order the
 * caller supplies.
 *
 * @module dsh-cascade-search/cascade
 */

/** Machine-routable error, shaped like the seam's own `WebError`. */
export class CascadeWebError extends Error {
  /**
   * @param {string} message - operator-facing diagnostic.
   * @param {string} code - stable machine code, surfaced in tool error metadata.
   */
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

/**
 * One backend attempt failed in a way the cascade should absorb.
 *
 * Its message becomes that backend's line in the degradation log, so it must
 * read as a reason ("HTTP 500: ..."), not as a sentence.
 */
export class BackendUnavailable extends Error {}

/**
 * Combine a caller cancellation signal with a per-attempt timeout.
 *
 * @param {AbortSignal | undefined} signal - the caller's signal.
 * @param {number} ms - the attempt budget.
 * @returns {AbortSignal} aborts on whichever comes first.
 */
export function signalWithTimeout(signal, ms) {
  try {
    const timeout = AbortSignal.timeout(ms)
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  } catch (error) {
    throw new CascadeWebError(
      `invalid timeout budget: ${sanitizeMessage(error)}`,
      'WEB_PROVIDER_ERROR',
      { cause: error },
    )
  }
}

/**
 * Throw when the caller cancelled.
 *
 * Called before every attempt and again inside every `catch`, so a real
 * cancellation propagates instead of silently falling through to the next
 * backend — which, for the last one, would be a billed request.
 *
 * @param {AbortSignal | undefined} signal - the caller's signal.
 * @param {ErrorConstructor} ErrorClass - the error class to raise.
 */
export function throwIfAborted(signal, ErrorClass = CascadeWebError) {
  if (signal?.aborted !== true) return
  throw new ErrorClass('cascade search aborted', 'WEB_ABORTED', {
    cause: signal.reason,
  })
}

/**
 * Read a response body as JSON, or raise {@link BackendUnavailable}.
 *
 * @param {Response} response - the fetch response.
 * @returns {Promise<any>} the parsed body.
 */
export async function readJson(response, signal, secrets = []) {
  let body
  try {
    body = await abortable(response.text(), signal)
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    if (response.ok) {
      throw new BackendUnavailable(`response body could not be read: ${sanitizeMessage(error, secrets)}`)
    }
    body = ''
  }
  if (!response.ok) {
    const detail = sanitizeMessage(body.slice(0, 200), secrets)
    throw new BackendUnavailable(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new BackendUnavailable(`unprocessable body: ${sanitizeMessage(error, secrets)}`)
  }
}

/** Never let an upstream envelope echo a credential into logs or tool output. */
export function sanitizeMessage(value, secrets = []) {
  let text = String(value?.message ?? value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[REDACTED]')
  }
  return text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+={0,2}/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:key|token|secret|api[_-]?key)[=:]\s*)[^\s;,}"']+/gi, '$1[REDACTED]')
}

export function abortable(operation, signal) {
  if (!signal) return Promise.resolve(operation)
  if (signal.aborted) return Promise.reject(signal.reason)
  const promise = Promise.resolve(operation)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Trim a snippet to a length the model can afford to read.
 *
 * @param {unknown} text - the candidate snippet.
 * @param {number} limit - maximum characters.
 * @returns {unknown} the snippet, possibly truncated.
 */
export function clip(text, limit = 1200) {
  return typeof text === 'string' && text.length > limit ? text.slice(0, limit) : text
}

/**
 * Build one normalized source, dropping empty optional fields.
 *
 * The seam's `WebSearchSource` has no room for `undefined`, so absent values
 * are omitted rather than set.
 *
 * @param {{ url?: unknown, title?: unknown, snippet?: unknown, publishedAt?: unknown }} fields
 * @returns {object | undefined} the source, or undefined without a url.
 */
export function toSource({ url, title, snippet, publishedAt }) {
  if (typeof url !== 'string' || url.length === 0) return undefined
  return {
    url,
    ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
    ...(typeof snippet === 'string' && snippet.length > 0 ? { snippet: clip(snippet) } : {}),
    ...(typeof publishedAt === 'string' && publishedAt.length > 0 ? { publishedAt } : {}),
  }
}

/**
 * Dedupe by url, preserving order.
 *
 * @param {Array<object | undefined>} sources - candidate sources.
 * @returns {object[]} unique sources.
 */
export function dedupe(sources) {
  const seen = new Set()
  const out = []
  for (const source of sources) {
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    out.push(source)
  }
  return out
}

/**
 * Clamp a requested result count to a backend's accepted range.
 *
 * @param {unknown} requested - the caller's `maxResults`.
 * @param {number} fallback - value used when absent or invalid.
 * @param {number} max - the backend's upper bound.
 * @returns {number} the clamped count.
 */
function count(requested, fallback, max) {
  if (requested === undefined) return fallback
  const value = typeof requested === 'string' && /^\d+$/.test(requested) ? Number(requested) : requested
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback
}

/**
 * Backend 1 — the self-hosted tavily-proxy.
 *
 * The proxy owns the Tavily key pool and authenticates callers with its own
 * management key, so no Tavily key belongs in this config. Local and cheap,
 * hence first.
 */
async function searchTavily(options, request, signal) {
  const attemptSignal = signalWithTimeout(signal, options.timeoutMs)
  const response = await fetch(`${options.url.replace(/\/+$/, '')}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey },
    body: JSON.stringify({
      query: request.query,
      max_results: count(request.maxResults, 8, 20),
      search_depth: options.depth ?? 'basic',
    }),
    redirect: 'error',
    signal: attemptSignal,
  })
  const body = await readJson(response, attemptSignal, [options.apiKey])
  const sources = (Array.isArray(body?.results) ? body.results : []).map((item) =>
    toSource({ url: item?.url, title: item?.title, snippet: item?.content }),
  )
  return {
    sources: dedupe(sources),
    truncated: false,
    ...(typeof body?.answer === 'string' && body.answer.length > 0 ? { content: body.answer } : {}),
  }
}

/**
 * Backend 2 — Querit.
 *
 * Results nest under `results.result[]` and the publication timestamp is
 * `page_age`; the envelope reports failure in `error_code`/`error_msg` even on
 * HTTP 200.
 */
async function searchQuerit(options, request, signal) {
  const attemptSignal = signalWithTimeout(signal, options.timeoutMs)
  const response = await fetch(options.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      query: request.query,
      count: count(request.maxResults, 10, 50),
      include_content: false,
    }),
    redirect: 'error',
    signal: attemptSignal,
  })
  const body = await readJson(response, attemptSignal, [options.apiKey])
  if (body?.error_code !== undefined && body.error_code !== 200) {
    throw new BackendUnavailable(`error ${body.error_code}: ${sanitizeMessage(body.error_msg ?? 'unknown', [options.apiKey])}`)
  }
  const items = Array.isArray(body?.results?.result) ? body.results.result : []
  const sources = items.map((item) =>
    toSource({
      url: item?.url,
      title: item?.title,
      snippet: item?.snippet,
      publishedAt: item?.page_age,
    }),
  )
  return { sources: dedupe(sources), truncated: false }
}

/**
 * Backend 3 — the DeepSeek Search API.
 *
 * Billed per successful call (5 元 / 1000 searches), so it is deliberately last:
 * it only runs once the two free backends are exhausted.
 */
async function searchDeepSeek(options, request, signal) {
  const attemptSignal = signalWithTimeout(signal, options.timeoutMs)
  const response = await fetch(options.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      query: request.query,
      count: count(request.maxResults, 10, 50),
      need_content: false,
    }),
    redirect: 'error',
    signal: attemptSignal,
  })
  const body = await readJson(response, attemptSignal, [options.apiKey])
  const items = Array.isArray(body?.results) ? body.results : []
  const sources = items.map((item) =>
    toSource({
      url: item?.url,
      title: item?.title,
      snippet: item?.snippet,
      publishedAt: item?.date,
    }),
  )
  return { sources: dedupe(sources), truncated: false }
}

/**
 * The three backends, keyed by the names used in `order`.
 *
 * `configured(options)` answers "is this backend usable at all" from a resolved
 * option snapshot; a backend that is not configured is skipped without a
 * network attempt.
 */
export const BACKEND_LABELS = {
  tavily: 'tavily-proxy',
  querit: 'querit',
  deepseek: 'deepseek-search-api',
}

export const CASCADE_BACKENDS = {
  tavily: {
    label: 'tavily-proxy',
    search: searchTavily,
    configured: (options) => Boolean(options.url && options.apiKey),
  },
  querit: {
    label: 'querit',
    search: searchQuerit,
    configured: (options) => Boolean(options.url && options.apiKey),
  },
  deepseek: {
    label: 'deepseek-search-api',
    search: searchDeepSeek,
    configured: (options) => Boolean(options.url && options.apiKey),
  },
}

/** Default priority: free local pool → free-ish third party → billed official. */
export const DEFAULT_ORDER = ['tavily', 'querit', 'deepseek']

/**
 * A `ctx.web` search provider that tries backends in priority order.
 *
 * The seam resolves exactly one provider id and has no priority chain, so the
 * cascade belongs here, inside a single provider.
 */
export class CascadeSearchProvider {
  /**
   * @param {() => Promise<object> | object} resolveOptions - resolves the options
   *   for the NEXT operation; may hit the credentials service, so it is awaited
   *   once per search rather than cached at mount.
   * @param {{ warn: Function } | undefined} logger - receives degradation warnings.
   * @param {typeof CascadeWebError} ErrorClass - the error class to raise; the
   *   plugin passes the seam's real `WebError` so `instanceof` checks upstream work.
   */
  constructor(resolveOptions, logger, ErrorClass = CascadeWebError) {
    this.resolveOptions = resolveOptions
    this.logger = logger
    this.ErrorClass = ErrorClass
    this.id = 'cascade-search'
  }

  /**
   * Always usable.
   *
   * Reporting `false` here would make the seam throw
   * `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` and discard every per-backend reason,
   * which is precisely the diagnostic this provider exists to preserve.
   *
   * @returns {true}
   */
  available() {
    return true
  }

  /**
   * Search, degrading through the configured order.
   *
   * @param {{ query: string, maxResults?: number }} request - the seam's request.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ sources: object[], truncated: boolean, content?: string }>}
   * @throws {Error} the configured error class when every backend fails.
   */
  async search(request, signal) {
    throwIfAborted(signal, this.ErrorClass)
    let options
    try {
      options = await abortable(this.resolveOptions(signal), signal)
    } catch (error) {
      throwIfAborted(signal, this.ErrorClass)
      if ((error instanceof CascadeWebError) || (error?.name === 'WebError' && typeof error.code === 'string')) throw error
      throw new this.ErrorClass('search configuration could not be resolved', 'WEB_PROVIDER_ERROR', {
        cause: error,
      })
    }
    throwIfAborted(signal, this.ErrorClass)
    const order =
      Array.isArray(options.order) && options.order.length > 0 ? options.order : DEFAULT_ORDER
    const skipped = []

    for (const name of order) {
      throwIfAborted(signal, this.ErrorClass)
      if (typeof name !== 'string' || Object.hasOwn(CASCADE_BACKENDS, name) === false) {
        skipped.push(`${String(name)}: unknown backend`)
        continue
      }
      const backend = CASCADE_BACKENDS[name]
      const settings = options.backends?.[name]
      if (settings?.enabled === false) {
        skipped.push(`${backend.label}: disabled`)
        continue
      }
      if (settings?.configurationError || settings?.credentialError) {
        const error = settings.configurationError ?? settings.credentialError
        skipped.push(`${backend.label}: ${sanitizeMessage(error, [settings?.apiKey])}`)
        continue
      }
      if (!backend.configured(settings ?? {})) {
        skipped.push(`${backend.label}: not configured`)
        continue
      }
      try {
        const result = await backend.search(settings, request, signal)
        if (result.sources.length === 0 && typeof result.content !== 'string') {
          skipped.push(`${backend.label}: no results`)
          continue
        }
        if (skipped.length > 0) {
          this.logger?.warn?.(
            'cascade-search: served "%s" by %s after %s',
            request.query,
            backend.label,
            skipped.join('; '),
          )
        }
        return result
      } catch (error) {
        // Re-check: a cancellation must not be mistaken for a backend failure.
        throwIfAborted(signal, this.ErrorClass)
        skipped.push(`${backend.label}: ${sanitizeMessage(error, [settings?.apiKey])}`)
      }
    }

    throw new this.ErrorClass(
      `all search backends failed for ${JSON.stringify(request.query)} — ${skipped.join('; ')}`,
      'WEB_PROVIDER_ERROR',
    )
  }
}
