/**
 * Config schema for dsh-cascade-search.
 *
 * `@deepseek-ai/schemastery` is host-provided — a peer dependency, exactly as in
 * every other DSH plugin — and is resolvable only inside a Harness profile. That
 * is why this module is imported exclusively by `./index.js`: the pure cascade
 * engine in `./cascade.js` stays dependency-free so `node --test` can run it
 * without booting a Harness.
 *
 * ## Why the field names are flat
 *
 * The settings page addresses one field per form control, and a control's write
 * path is a single segment (`settingsTextField('tavilyUrl')` → `path:
 * ['tavilyUrl']`). A nested block (`tavily.url`) would therefore be unreachable
 * from the GUI. Flat keys with a backend prefix are the price of a form-driven
 * config; they still read fine in `cordis.patch.yml`.
 *
 * ## Why every field is volatile
 *
 * `.volatile()` is what makes a field editable from the settings page: the Host
 * projects ONLY volatile fields into the form (`volatileForm`) and rejects a
 * write to any other path. A volatile field arrives at `apply()` as a frozen
 * reference — `{ get(), [Symbol.for('cosmokit.volatile.write')] }` — instead of a
 * plain value, so a GUI save updates the live reference in place and the next
 * search reads the new value without restarting the plugin.
 *
 * @module dsh-cascade-search/config
 */

import z from '@deepseek-ai/schemastery'

/** Backend ids, in their default priority order. */
export const BACKENDS = ['tavily', 'querit', 'deepseek']

/**
 * Defaults, keyed by the flat field name the settings page edits.
 *
 * Order is data, not code: to try the official API first, edit `order` instead of
 * touching the engine.
 *
 * - `tavily` — the self-hosted proxy. Local, owns its own key pool, free per
 *   call, so it goes first.
 * - `querit` — third-party, account-quota rather than per-call billing.
 * - `deepseek` — the official Search API, billed per successful call
 *   (5 元 / 1000 searches), so it is deliberately last.
 */
export const DEFAULTS = {
  order: [...BACKENDS],
  adopt: true,
  tavilyEnabled: true,
  tavilyUrl: 'http://localhost:9100',
  tavilyCredentialRef: 'TAVILY_PROXY_AUTH_KEY',
  tavilyTimeoutMs: 10_000,
  tavilyDepth: 'basic',
  queritEnabled: true,
  queritUrl: 'https://api.querit.ai/v1/search',
  queritCredentialRef: 'QUERIT_API_KEY',
  queritTimeoutMs: 25_000,
  deepseekEnabled: true,
  deepseekUrl: 'https://api.deepseek.com/v1/tools/search',
  deepseekCredentialRef: 'DEEPSEEK_API_KEY',
  deepseekTimeoutMs: 60_000,
}

/**
 * Retire a tier without deleting its credential.
 *
 * Turning `deepseekEnabled` off stops the billed fallback while the key stays in
 * the credential store, ready to switch back on.
 *
 * @param {string} id - backend id.
 * @returns {object} the boolean schema.
 */
const enabled = (id) => z.boolean().default(DEFAULTS[`${id}Enabled`]).volatile()

/**
 * Endpoint the backend POSTs to.
 *
 * @param {string} id - backend id.
 * @returns {object} the string schema.
 */
const url = (id) => z.string().default(DEFAULTS[`${id}Url`]).volatile()

/**
 * Name of the credential the backend resolves, e.g. `QUERIT_API_KEY`.
 *
 * A reference, never the secret: keys live in the credential store and only the
 * reference name rides the settings document. The settings page writes the key
 * itself through the `credentials` remote namespace, addressed by this name.
 *
 * @param {string} id - backend id.
 * @returns {object} the string schema.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const credentialRef = (id) => z.string()
  .pattern(CREDENTIAL_REF_PATTERN)
  .default(DEFAULTS[`${id}CredentialRef`])
  .volatile()

/**
 * Per-attempt budget in milliseconds.
 *
 * @param {string} id - backend id.
 * @returns {object} the number schema.
 */
const timeoutMs = (id) => z.number()
  .min(1)
  .max(600_000)
  .step(1)
  .default(DEFAULTS[`${id}TimeoutMs`])
  .volatile()

/**
 * Plugin config.
 *
 * `adopt` re-points `web.config.searchProvider` at this provider on mount, which
 * is what keeps a profile-level pin — or a save on the built-in Web search page —
 * from silently displacing the cascade. It is read once, at mount.
 */
export const Config = z.object({
  /** Priority list of backend ids; unknown ids are skipped with a log line. */
  order: z.array(z.string()).default([...DEFAULTS.order]).volatile(),
  adopt: z.boolean().default(DEFAULTS.adopt).volatile(),

  tavilyEnabled: enabled('tavily'),
  tavilyUrl: url('tavily'),
  tavilyCredentialRef: credentialRef('tavily'),
  tavilyTimeoutMs: timeoutMs('tavily'),
  /** tavily-proxy's `search_depth`: `basic` or `advanced`. */
  tavilyDepth: z.string().default(DEFAULTS.tavilyDepth).volatile(),

  queritEnabled: enabled('querit'),
  queritUrl: url('querit'),
  queritCredentialRef: credentialRef('querit'),
  queritTimeoutMs: timeoutMs('querit'),

  deepseekEnabled: enabled('deepseek'),
  deepseekUrl: url('deepseek'),
  deepseekCredentialRef: credentialRef('deepseek'),
  deepseekTimeoutMs: timeoutMs('deepseek'),
})
