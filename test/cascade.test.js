/**
 * Unit tests for the cascade engine.
 *
 * These run under plain `node --test`, with no Harness profile and no network:
 * `fetch` is replaced with a stub, so each test asserts which backends were
 * attempted, in what order, and what the caller finally received.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  CascadeSearchProvider,
  CascadeWebError,
  DEFAULT_ORDER,
  dedupe,
  toSource,
} from '../lib/cascade.js'

/** Collects what a stubbed `fetch` was asked to do. */
const calls = []

/**
 * Install a fetch stub mapping url fragment → handler.
 *
 * @param {Record<string, (body: any) => any>} routes - fragment to handler;
 *   a handler either returns a body (HTTP 200) or throws to simulate failure.
 * @returns {void}
 */
function stubFetch(routes) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    const fragment = Object.keys(routes).find((key) => url.includes(key))
    if (fragment === undefined) throw new Error(`unstubbed url ${url}`)
    const handler = routes[fragment]
    if (typeof handler === 'function') {
      const result = await handler(body, init.signal, url)
      if (result instanceof Error) throw result
      if (result instanceof Response || typeof result?.text === 'function') return result
      return new Response(JSON.stringify(result), { status: 200 })
    }
    if (typeof handler?.text === 'function' && typeof handler?.ok === 'boolean') return handler
    return new Response(JSON.stringify(handler), { status: 200 })
  }
}

/** A complete option snapshot with all three backends configured. */
function options(overrides = {}) {
  return {
    order: ['tavily', 'querit', 'deepseek'],
    backends: {
      tavily: { enabled: true, url: 'http://localhost:9100', apiKey: 'k', timeoutMs: 1_000 },
      querit: { enabled: true, url: 'https://api.querit.ai/v1/search', apiKey: 'k', timeoutMs: 1_000 },
      deepseek: { enabled: true, url: 'https://api.deepseek.com/v1/tools/search', apiKey: 'k', timeoutMs: 1_000 },
      ...overrides,
    },
  }
}

/** A logger that records warnings instead of printing them. */
function logger() {
  const warnings = []
  return { warnings, warn: (...args) => warnings.push(args.map(String).join(' ')) }
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  delete globalThis.fetch
})

describe('normalization helpers', () => {
  it('drops sources without a url and omits empty optional fields', () => {
    assert.equal(toSource({ url: '' }), undefined)
    assert.equal(toSource({ title: 'no url' }), undefined)
    assert.deepEqual(toSource({ url: 'https://a.example', title: '', snippet: '' }), {
      url: 'https://a.example',
    })
  })

  it('clips an overlong snippet', () => {
    const source = toSource({ url: 'https://a.example', snippet: 'x'.repeat(5000) })
    assert.equal(source.snippet.length, 1200)
  })

  it('dedupes by url, preserving the first occurrence', () => {
    const out = dedupe([
      { url: 'a', title: 'first' },
      { url: 'b' },
      { url: 'a', title: 'second' },
    ])
    assert.deepEqual(out.map((s) => s.url), ['a', 'b'])
    assert.equal(out[0].title, 'first')
  })
})

describe('cascade order', () => {
  it('serves from tavily without touching the paid fallback', async () => {
    stubFetch({
      'localhost:9100': { results: [{ url: 'https://a.example', title: 'A', content: 'snippet' }] },
    })
    const log = logger()
    const provider = new CascadeSearchProvider(() => options(), log)

    const result = await provider.search({ query: 'q' })

    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].url, 'https://a.example')
    assert.equal(calls.length, 1, 'only the first backend should run')
    assert.deepEqual(log.warnings, [], 'no degradation means no warning')
  })

  it('supports synchronous option resolvers with an AbortSignal', async () => {
    stubFetch({ 'localhost:9100': { results: [], answer: 'Useful answer' } })
    const provider = new CascadeSearchProvider(() => options(), logger())
    const result = await provider.search({ query: 'q' }, new AbortController().signal)
    assert.equal(result.content, 'Useful answer')
    assert.equal(calls.length, 1)
    assert.equal(result.answer, undefined, 'the Host only consumes the content field')  })

  it('falls through tavily -> querit when tavily is down', async () => {
    stubFetch({
      'localhost:9100': () => new Error('ECONNREFUSED'),
      'api.querit.ai': { results: { result: [{ url: 'https://b.example', snippet: 's' }] } },
    })
    const log = logger()
    const provider = new CascadeSearchProvider(() => options(), log)

    const result = await provider.search({ query: 'q' })

    assert.deepEqual(result.sources.map((s) => s.url), ['https://b.example'])
    assert.deepEqual(calls.map((c) => new URL(c.url).host), ['localhost:9100', 'api.querit.ai'])
    assert.equal(log.warnings.length, 1)
    assert.match(log.warnings[0], /querit/)
    assert.match(log.warnings[0], /tavily-proxy/)
  })

  it('falls all the way to deepseek when both free backends are down', async () => {
    stubFetch({
      'localhost:9100': () => new Error('ECONNREFUSED'),
      'api.querit.ai': () => new Error('HTTP 429: rate limited'),
      'api.deepseek.com': { results: [{ url: 'https://c.example', title: 'C' }] },
    })
    const log = logger()
    const provider = new CascadeSearchProvider(() => options(), log)

    const result = await provider.search({ query: 'q' })

    assert.deepEqual(result.sources.map((s) => s.url), ['https://c.example'])
    assert.deepEqual(calls.map((c) => new URL(c.url).host), [
      'localhost:9100',
      'api.querit.ai',
      'api.deepseek.com',
    ])
    assert.equal(log.warnings.length, 1, 'two degradations, one warning before serving')
    assert.match(log.warnings[0], /deepseek-search-api/)
  })

  it('honours a reordered priority list', async () => {
    stubFetch({
      'api.deepseek.com': { results: [{ url: 'https://d.example' }] },
    })
    const provider = new CascadeSearchProvider(
      () => ({ ...options(), order: ['deepseek', 'tavily', 'querit'] }),
      logger(),
    )

    const result = await provider.search({ query: 'q' })

    assert.deepEqual(result.sources.map((s) => s.url), ['https://d.example'])
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /api\.deepseek\.com/)
  })
})

describe('backend availability', () => {
  it('skips a backend that is disabled without calling it', async () => {
    stubFetch({
      'api.querit.ai': { results: { result: [{ url: 'https://e.example' }] } },
    })
    const provider = new CascadeSearchProvider(
      () => options({ tavily: { enabled: false, url: 'http://localhost:9100', apiKey: 'k', timeoutMs: 1_000 } }),
      logger(),
    )

    await provider.search({ query: 'q' })

    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /api\.querit\.ai/)
  })

  it('skips a backend with no credential', async () => {
    stubFetch({
      'api.querit.ai': { results: { result: [{ url: 'https://f.example' }] } },
    })
    const provider = new CascadeSearchProvider(
      () => options({ tavily: { enabled: true, url: 'http://localhost:9100', timeoutMs: 1_000 } }),
      logger(),
    )

    await provider.search({ query: 'q' })

    assert.equal(calls.length, 1, 'an unconfigured backend costs no request')
    assert.match(calls[0].url, /api\.querit\.ai/)
  })

  it('treats an empty result set as unavailable and keeps descending', async () => {
    stubFetch({
      'localhost:9100': { results: [] },
      'api.querit.ai': { results: { result: [{ url: 'https://g.example' }] } },
    })
    const log = logger()
    const provider = new CascadeSearchProvider(() => options(), log)

    const result = await provider.search({ query: 'q' })

    assert.deepEqual(result.sources.map((s) => s.url), ['https://g.example'])
    assert.match(log.warnings[0], /no results/)
  })
})

describe('failure reporting', () => {
  it('reports every reason when all backends fail', async () => {
    stubFetch({
      'localhost:9100': () => new Error('ECONNREFUSED'),
      'api.querit.ai': () => new Error('HTTP 401: bad key'),
      'api.deepseek.com': () => new Error('HTTP 500: boom'),
    })
    const provider = new CascadeSearchProvider(() => options(), logger())

    await assert.rejects(
      provider.search({ query: 'q' }),
      (error) => {
        assert.match(error.message, /all search backends failed/)
        assert.match(error.message, /tavily-proxy: .*ECONNREFUSED/)
        assert.match(error.message, /querit: .*401/)
        assert.match(error.message, /deepseek-search-api: .*500/)
        assert.equal(error.code, 'WEB_PROVIDER_ERROR')
        return true
      },
    )
  })

  it('is always available, so per-backend reasons survive', () => {
    const provider = new CascadeSearchProvider(() => options(), logger())
    assert.equal(provider.available(), true)
    assert.equal(provider.id, 'cascade-search')
  })

  it('propagates cancellation instead of degrading', async () => {
    stubFetch({ 'localhost:9100': () => new Error('aborted') })
    const controller = new AbortController()
    controller.abort()
    const provider = new CascadeSearchProvider(() => options(), logger())

    await assert.rejects(provider.search({ query: 'q' }, controller.signal), (error) => {
      assert.equal(error.code, 'WEB_ABORTED')
      return true
    })
    assert.equal(calls.length, 0, 'a cancelled search makes no request')
  })

  it('aborts an in-flight request immediately and makes no paid fallback', async () => {
    let release
    const controller = new AbortController()
    stubFetch({
      'localhost:9100': (body, signal) => new Promise((resolve, reject) => {
        release = () => resolve({ results: [] })
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
      'api.deepseek.com': { results: [{ url: 'https://paid.example' }] },
    })
    const provider = new CascadeSearchProvider(() => options(), logger())
    const pending = provider.search({ query: 'q' }, controller.signal)
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort(new Error('caller cancelled'))
    await assert.rejects(pending, (error) => error.code === 'WEB_ABORTED')
    assert.equal(calls.length, 1)
    release()
  })

  it('times out a stalled response body without exceeding the caller budget', async () => {
    stubFetch({ 'localhost:9100': () => ({ text: () => new Promise(() => {}) }) })
    const provider = new CascadeSearchProvider(() => options({
      tavily: { enabled: true, url: 'http://localhost:9100', apiKey: 'k', timeoutMs: 20 },
      querit: { enabled: false }, deepseek: { enabled: false },
    }), logger())
    await assert.rejects(provider.search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_ERROR' && /timeout/.test(error.message))
    assert.equal(calls.length, 1)
  })

  it('surfaces a credential read error only for its tier', async () => {
    const failure = new CascadeWebError('Credential "BROKEN" could not be read', 'WEB_PROVIDER_ERROR')
    const provider = new CascadeSearchProvider(() => options({
      tavily: { enabled: true, url: 'http://localhost:9100', credentialError: failure },
    }), logger())
    await assert.rejects(provider.search({ query: 'q' }), (error) => {
      assert.equal(error.code, 'WEB_PROVIDER_ERROR')
      assert.match(error.message, /Credential "BROKEN"/)
      assert.doesNotMatch(error.message, /could not be resolved/)
      return true
    })
  })

  it('surfaces a JSON error envelope that arrives with HTTP 200', async () => {
    stubFetch({
      'localhost:9100': () => new Error('ECONNREFUSED'),
      'api.querit.ai': { error_code: 400, error_msg: 'query too long' },
      'api.deepseek.com': { results: [{ url: 'https://h.example' }] },
    })
    const provider = new CascadeSearchProvider(() => options(), logger())

    const result = await provider.search({ query: 'q' })

    assert.deepEqual(result.sources.map((s) => s.url), ['https://h.example'])
  })
})

describe('request shaping', () => {
  it('redacts literal keys and common authorization forms in errors and logs', async () => {
    const secret = 'sk-this-is-a-test-secret'
    stubFetch({
      'localhost:9100': (body, signal, url) => new Response(`Bearer ${secret} key=${secret}`, { status: 401 }),
      'api.querit.ai': { error_code: 403, error_msg: `Bearer ${secret}` },
      'api.deepseek.com': new Error(`token: ${secret}`),
    })
    const log = logger()
    const provider = new CascadeSearchProvider(() => options({
      tavily: { enabled: true, url: 'http://localhost:9100', apiKey: secret, timeoutMs: 100 },
      querit: { enabled: true, url: 'https://api.querit.ai/v1/search', apiKey: secret, timeoutMs: 100 },
      deepseek: { enabled: true, url: 'https://api.deepseek.com/v1/tools/search', apiKey: secret, timeoutMs: 100 },
    }), log)
    await assert.rejects(provider.search({ query: 'q' }))
    assert.doesNotMatch(log.warnings.join('\n'), /this-is-a-test-secret|Bearer sk-/)
    assert.equal(calls.length, 3)
  })

  it('normalizes invalid per-attempt timeout budgets before fetch', async () => {
    for (const timeoutMs of [-1, 1.5, Infinity, NaN, 4_294_967_296]) {
      const provider = new CascadeSearchProvider(() => options({
        tavily: { enabled: true, url: 'http://localhost:9100', apiKey: 'k', timeoutMs },
        querit: { enabled: false }, deepseek: { enabled: false },
      }), logger())
      await assert.rejects(provider.search({ query: 'q' }),
        (error) => error.code === 'WEB_PROVIDER_ERROR' && /invalid timeout/.test(error.message))
    }
    assert.equal(calls.length, 0)
  })

  it('clamps maxResults per backend instead of forwarding blindly', async () => {
    stubFetch({ 'localhost:9100': { results: [{ url: 'https://i.example' }] } })
    const provider = new CascadeSearchProvider(() => options(), logger())

    await provider.search({ query: 'q', maxResults: 999 })

    assert.equal(calls[0].body.max_results, 20, 'tavily caps at 20')
  })

  it('defaults the count when maxResults is absent', async () => {
    stubFetch({ 'localhost:9100': { results: [{ url: 'https://j.example' }] } })
    const provider = new CascadeSearchProvider(() => options(), logger())

    await provider.search({ query: 'q' })

    assert.equal(calls[0].body.max_results, 8)
  })

  it('forwards the query verbatim', async () => {
    stubFetch({ 'localhost:9100': { results: [{ url: 'https://k.example' }] } })
    const provider = new CascadeSearchProvider(() => options(), logger())

    await provider.search({ query: '南宁市 算力券 政策' })

    assert.equal(calls[0].body.query, '南宁市 算力券 政策')
  })
})

describe('default order', () => {
  it('is free backends before the billed one', () => {
    assert.deepEqual(DEFAULT_ORDER, ['tavily', 'querit', 'deepseek'])
    assert.equal(DEFAULT_ORDER.at(-1), 'deepseek')
  })
})

describe('error class injection', () => {
  it('raises the class it was given', async () => {
    class HostWebError extends Error {
      constructor(message, code) {
        super(message)
        this.code = code
      }
    }
    stubFetch({ 'localhost:9100': () => new Error('down') })
    const provider = new CascadeSearchProvider(
      () => ({ ...options(), order: ['tavily'] }),
      logger(),
      HostWebError,
    )

    await assert.rejects(provider.search({ query: 'q' }), HostWebError)
  })

  it('falls back to its own error class when the host has none', async () => {
    stubFetch({ 'localhost:9100': () => new Error('down') })
    const provider = new CascadeSearchProvider(() => ({ ...options(), order: ['tavily'] }), logger())

    await assert.rejects(provider.search({ query: 'q' }), CascadeWebError)
  })
})
