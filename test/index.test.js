import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply } from '../lib/index.js'

const WRITE = Symbol.for('cosmokit.volatile.write')
const tick = () => new Promise((resolve) => setImmediate(resolve))

function config() {
  return {
    order: ['tavily', 'querit', 'deepseek'], adopt: true,
    tavilyEnabled: true, tavilyUrl: 'http://localhost:9100', tavilyCredentialRef: 'TAVILY_PROXY_AUTH_KEY',
    tavilyTimeoutMs: 10000, tavilyDepth: 'basic',
    queritEnabled: true, queritUrl: 'https://api.querit.ai/v1/search', queritCredentialRef: 'QUERIT_API_KEY',
    queritTimeoutMs: 25000,
    deepseekEnabled: true, deepseekUrl: 'https://api.deepseek.com/v1/tools/search', deepseekCredentialRef: 'DEEPSEEK_API_KEY',
    deepseekTimeoutMs: 60000,
  }
}

function host(entries, provider = {}) {
  const effects = []
  const result = {
    ...provider,
    config: { searchProvider: { [WRITE](value) { this.value = value }, value: 'original' } },
    registerSearchProvider(value) {
      this.providers ??= new Map()
      this.providers.set(value.id, value)
      return () => this.providers.delete(value.id)
    },
    effects,
  }
  const ctx = {
    web: result,
    get: (name) => name === 'credentials' ? entries : undefined,
    effect: (cleanup) => effects.push(cleanup),
    logger: { info() {}, warn() {} },
  }
  return { ctx, web: result }
}

describe('volatile configuration and provider registration', () => {
  it('adopts the provider exactly once and disposes its registration', async () => {
    const { ctx, web } = host({ resolve: async () => 'unused' })
    apply(ctx, config())
    assert.equal(web.config.searchProvider.value, 'cascade-search')
    assert.equal(web.providers.size, 1)
    assert.equal(ctx.web.effects.length, 1)
    const dispose = await ctx.web.effects[0]()
    await dispose()
    assert.equal(web.providers.size, 0)
  })

  it('freezes all volatile fields before credentials yield, including order and depth', async () => {
    const originalFetch = globalThis.fetch
    const pending = []
    const calls = []
    const values = config()
    const { ctx } = host({ resolve: (ref) => new Promise((resolve) => pending.push({ ref, resolve })) })
    apply(ctx, values)
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ results: [], answer: 'ok' }), { status: 200 })
    }
    try {
      const promise = ctx.web.providers.get('cascade-search').search({ query: 'q' }, new AbortController().signal)
      await tick()
      // A GUI save arrives WHILE credentials resolve. Never pair its URL with
      // the old key or reverse a query that was staged on the old order/depth.
      values.tavilyUrl = 'https://new-endpoint.test'
      values.tavilyCredentialRef = 'NEW_KEY'
      values.order = ['deepseek']
      values.tavilyDepth = 'advanced'
      pending[0].resolve('key-of-TAVILY_PROXY_AUTH_KEY')
      pending[1].resolve('querit-key')
      pending[2].resolve('deepseek-key')
      const result = await promise
      assert.equal(result.content, 'ok')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'http://localhost:9100/search')
      assert.equal(calls[0].init.headers['x-api-key'], 'key-of-TAVILY_PROXY_AUTH_KEY')
      assert.equal(JSON.parse(calls[0].init.body).search_depth, 'basic')
    } finally {
      if (originalFetch === undefined) delete globalThis.fetch
      else globalThis.fetch = originalFetch
    }
  })

  it('does not resolve disabled or out-of-order credentials, and resolves active tiers concurrently', async () => {
    const resolved = []
    let release
    const pending = new Promise((resolve) => { release = resolve })
    const originalFetch = globalThis.fetch
    const { ctx } = host({ resolve: async (ref) => { resolved.push(ref); await pending; return 'secret' } })
    const values = { ...config(), order: ['deepseek'], queritEnabled: false }
    apply(ctx, values)
    globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ url: 'https://d.example' }] }))
    try {
      const promise = ctx.web.providers.get('cascade-search').search({ query: 'q' })
      await tick()
      assert.deepEqual(resolved, ['DEEPSEEK_API_KEY'])
      release()
      await promise
    } finally {
      if (originalFetch === undefined) delete globalThis.fetch
      else globalThis.fetch = originalFetch
    }
  })

  it('cancels credential resolution immediately without a fetch or lingering listener', async () => {
    const controller = new AbortController()
    const listeners = new Set()
    const add = EventTarget.prototype.addEventListener
    const remove = EventTarget.prototype.removeEventListener
    controller.signal.addEventListener = function (type, listener, options) {
      if (type === 'abort') {
        const original = listener
        listener = function (...args) {
          remove.call(this, type, listener, options)
          listeners.delete(listener)
          return typeof original === 'function' ? original.apply(this, args) : original?.handleEvent?.(...args)
        }
        listeners.add(listener)
      }
      return add.call(this, type, listener, options)
    }
    controller.signal.removeEventListener = function (type, listener, options) {
      if (type === 'abort') listeners.delete(listener)
      return remove.call(this, type, listener, options)
    }
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response('{}') }
    const { ctx } = host({ resolve: () => new Promise(() => {}) })
    apply(ctx, config())
    try {
      const pending = ctx.web.providers.get('cascade-search').search({ query: 'q' }, controller.signal)
      await tick()
      controller.abort(new Error('stop'))
      await assert.rejects(pending, (error) => error.code === 'WEB_ABORTED')
      assert.equal(calls, 0)
      assert.equal(listeners.size, 0)
    } finally {
      if (originalFetch === undefined) delete globalThis.fetch
      else globalThis.fetch = originalFetch
    }
  })

  it('isolates credential failures to their own backend without exposing a secret', async () => {
    const originalFetch = globalThis.fetch
    const { ctx } = host({
      resolve: async (ref) => {
        if (ref === 'TAVILY_PROXY_AUTH_KEY') throw new Error('EACCES cannot read secret-internal-path')
        if (ref === 'QUERIT_API_KEY') throw new Error('unavailable secret-querit')
        return 'deepseek-key'
      },
    })
    apply(ctx, config())
    globalThis.fetch = async () => new Response(JSON.stringify({ results: [{ url: 'https://d.example' }] }))
    try {
      const result = await ctx.web.providers.get('cascade-search').search({ query: 'q' })
      assert.equal(result.sources[0].url, 'https://d.example')
    } finally {
      if (originalFetch === undefined) delete globalThis.fetch
      else globalThis.fetch = originalFetch
    }
  })

  it('falls back safely when a hand-edited timeout bypasses schema validation', async () => {
    const { ctx } = host({ resolve: async () => 'key' })
    apply(ctx, { ...config(), tavilyTimeoutMs: NaN, queritTimeoutMs: Infinity, deepseekTimeoutMs: 1.5 })
    await assert.rejects(ctx.web.providers.get('cascade-search').search({ query: 'q' }), (error) =>
      error.code === 'WEB_PROVIDER_ERROR' && /integer from 1 to 600000/.test(error.message) && !/could not be resolved/.test(error.message))
  })
})
