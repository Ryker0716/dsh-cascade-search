import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Config, CREDENTIAL_REF_PATTERN } from '../lib/config.js'

function resolved(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value.get()]))
}

// Uses the exact host Schemastery version (a dev dependency, never a runtime one).
describe('host configuration schema', () => {
  it('preserves the documented defaults without bootstrapping a profile', () => {
    const config = resolved(Config({}))
    assert.deepEqual(config.order, ['tavily', 'querit', 'deepseek'])
    assert.equal(config.deepseekUrl, 'https://api.deepseek.com/v1/tools/search')
    assert.equal(config.tavilyTimeoutMs, 10000)
  })

  it('rejects credential refs that the credentials gateway cannot accept', () => {
    for (const ref of ['bad-name', '1DEEPSEEK', 'TOKEN VALUE', 'TOKEN.SUFFIX', 'TOKEN/SLASH']) {
      assert.equal(CREDENTIAL_REF_PATTERN.test(ref), false)
      assert.throws(() => Config({ queritCredentialRef: ref }))
    }
    assert.equal(CREDENTIAL_REF_PATTERN.test('_VALID_123'), true)
    assert.equal(Config({ queritCredentialRef: '_VALID_123' }).queritCredentialRef.get(), '_VALID_123')
  })

  it('rejects all invalid timeout shapes, including NaN and Infinity', () => {
    for (const value of [-1, 0, 1.5, Infinity, -Infinity, NaN, 600001, 4_294_967_296, 'ten']) {
      assert.throws(() => Config({ deepseekTimeoutMs: value }), undefined, String(value))
    }
    for (const value of [1, 20, 10000, 600000]) {
      assert.equal(Config({ deepseekTimeoutMs: value }).deepseekTimeoutMs.get(), value)
    }
  })
})
