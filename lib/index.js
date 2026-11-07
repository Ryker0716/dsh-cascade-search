/**
 * Host half of dsh-cascade-search.
 *
 * The DeepSeek Harness `ctx.web` seam resolves exactly ONE search provider id
 * and has no priority chain — `$DSH_WEB_SEARCH_PROVIDER` overrides that same
 * field, it is not a chain either. So the cascade lives inside a single
 * provider, registered here as `cascade-search`.
 *
 * Registering is not sufficient, though: `dsh.bundle.patch` is applied BEFORE
 * the user profile, so a profile that pins `web.config.searchProvider` to
 * another id would silently win. {@link apply} therefore re-points the seam at
 * this provider at mount time. Since the seam's field is a volatile reference
 * read on every search, that also survives a later settings-page save.
 *
 * ## Volatile config
 *
 * Every field of {@link Config} is `.volatile()`, so `apply()` receives frozen
 * references rather than values. Two consequences shape this file:
 *
 * 1. Values are read through {@link field}, which unwraps a reference with
 *    `.get()` and passes a plain value through unchanged. That keeps the module
 *    testable and tolerant of a host that resolves config differently.
 * 2. Reading happens INSIDE the per-search resolver, not once at mount, so a
 *    save on the settings page takes effect on the next search instead of after
 *    an application restart. The settings page writes the profile patch, the
 *    loader commits the new values into the running references, and the next
 *    `field()` call sees them.
 *
 * @module dsh-cascade-search
 */

import {
  abortable,
  CascadeSearchProvider,
  CascadeWebError,
  DEFAULT_ORDER,
  BACKEND_LABELS,
} from './cascade.js'
import { Config, DEFAULTS } from './config.js'

export { Config }

export const name = 'cascade-search'

/** The seam must exist before this plugin can register into it. */
export const inject = ['web']

/** Symbol the config runtime uses to mutate a volatile reference. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Read one config field, whether it arrived as a reference or a plain value.
 *
 * @param {any} value - a volatile reference or an already-resolved value.
 * @returns {any} the current value.
 */
function field(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/**
 * Assign a volatile config ref to a new provider id.
 *
 * Cordis wraps `z.string().volatile()` fields in a frozen reference whose only
 * write channel is `Symbol.for('cosmokit.volatile.write')`. No other setter
 * exists on that shape, so this is the only mutation attempted.
 *
 * @param {any} ref - the config field reference.
 * @param {string} value - the provider id to adopt.
 * @returns {boolean} whether the value was written.
 */
function adoptProviderId(ref, value) {
  if (ref === undefined || ref === null) return false
  if (typeof ref === 'object' && typeof ref[VOLATILE_WRITE] === 'function') {
    ref[VOLATILE_WRITE](value)
    return true
  }
  return false
}

/**
 * Read one credential through the credentials service, when it is mounted.
 *
 * Resolved lazily on every search rather than cached at mount, for two reasons:
 * the credentials service can apply after this plugin, and a key saved on the
 * settings page must take effect without restarting the app.
 *
 * @param {any} ctx - the Cordis context.
 * @param {string} ref - the credential ref name, e.g. `QUERIT_API_KEY`.
 * @returns {Promise<string | undefined>} the secret, when present.
 */
async function credential(ctx, ref) {
  if (typeof ref !== 'string' || ref.length === 0) return undefined
  let service
  try {
    service = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  } catch (error) {
    throw new CascadeWebError('The credentials service could not be read', 'WEB_PROVIDER_ERROR', {
      cause: error,
    })
  }
  if (typeof service?.resolve !== 'function') return undefined
  try {
    const resolved = await service.resolve(ref)
    // The credentials service resolves to `{ value, source }`; a plain string is
    // also accepted so a simpler host implementation still works.
    const value = typeof resolved === 'string' ? resolved : resolved?.value
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch (error) {
    throw new CascadeWebError(`Credential "${ref}" could not be read`, 'WEB_PROVIDER_ERROR', {
      cause: error,
    })
  }
}

/**
 * The provider order, falling back to the built-in default.
 *
 * @param {any} value - the `order` config field.
 * @returns {string[]} non-empty order to walk.
 */
function orderOf(value) {
  const order = field(value)
  return Array.isArray(order) && order.length > 0 ? order : DEFAULT_ORDER
}

/**
 * Build the per-search option resolver handed to {@link CascadeSearchProvider}.
 *
 * Only active tiers are resolved, concurrently with Promise.allSettled. A
 * failed credential service on one tier must not poison a usable earlier tier.
 * The whole snapshot is rebuilt per search so settings changes apply immediately.
 *
 * @param {any} ctx - the Cordis context.
 * @param {object} config - the validated config, holding volatile references.
 * @returns {(signal?: AbortSignal) => Promise<object>} resolves one full option snapshot.
 */
function makeResolver(ctx, config) {
  return async (signal) => {
    // Read EVERY volatile field synchronously before the first await. Mixing an
    // old credential with a new endpoint during a GUI save is worse than using
    // either complete snapshot, especially on the billed DeepSeek endpoint.
    const order = orderOf(config.order)
    const backends = Object.fromEntries(Object.keys(BACKEND_LABELS).map((id) => {
      const suffixes = ['Enabled', 'Url', 'CredentialRef', 'TimeoutMs']
      const values = suffixes.map((suffix) => field(config[`${id}${suffix}`]))
      const depth = id === 'tavily' ? field(config.tavilyDepth) : undefined
      const settings = {
        enabled: values[0] ?? DEFAULTS[`${id}Enabled`],
        url: values[1] ?? DEFAULTS[`${id}Url`],
        ref: values[2] ?? DEFAULTS[`${id}CredentialRef`],
        timeoutMs: values[3] ?? DEFAULTS[`${id}TimeoutMs`],
        ...(depth === undefined ? {} : { depth }),
      }
      if (!Number.isFinite(settings.timeoutMs) || !Number.isInteger(settings.timeoutMs) ||
          settings.timeoutMs < 1 || settings.timeoutMs > 600_000) {
        settings.configurationError = new CascadeWebError(
          `${BACKEND_LABELS[id]} timeout must be an integer from 1 to 600000 ms`,
          'WEB_PROVIDER_ERROR',
        )
      }
      return [id, settings]
    }))
    const active = [...new Set(order)].filter((id) =>
      Object.hasOwn(backends, id) && backends[id].enabled !== false && !backends[id].configurationError,
    )
    const resolved = await Promise.allSettled(active.map((id) =>
      abortable(credential(ctx, backends[id].ref), signal),
    ))
    resolved.forEach((result, index) => {
      const settings = backends[active[index]]
      if (result.status === 'fulfilled') {
        settings.apiKey = result.value
      } else {
        // Only the tier that actually needs this credential fails. A stale key
        // on an unused, disabled or later tier must not poison a good first hit.
        settings.credentialError = result.reason
      }
    })
    return { order, backends }
  }
}

/**
 * Cordis entry point.
 *
 * @param {any} ctx - the Cordis context, with `web` injected.
 * @param {object} config - the validated {@link Config}.
 */
export function apply(ctx, config) {
  const provider = new CascadeSearchProvider(makeResolver(ctx, config), ctx.logger)

  // Opportunistic: adopt the seam's real WebError so upstream `instanceof`
  // holds. The class is a module export of the web package — unreachable from
  // the service instance — so the only channel is a dynamic import. When that
  // cannot resolve (bare host, unit tests), the provider keeps its own
  // WebError-shaped CascadeWebError; behaviour is identical either way.
  void import('@deepseek-ai/dsh-web')
    .then((mod) => {
      if (typeof mod?.WebError === 'function') provider.ErrorClass = mod.WebError
    })
    .catch(() => {})

  const dispose = ctx.web.registerSearchProvider(provider)
  ctx.effect(() => dispose, 'cascade-search: registered provider')

  if (field(config.adopt)) {
    if (adoptProviderId(ctx.web?.config?.searchProvider, provider.id)) {
      ctx.logger?.info?.('cascade-search: adopted web search provider %s', provider.id)
    } else {
      ctx.logger?.warn?.(
        'cascade-search: could not adopt the seam config; ' +
          'set web.config.searchProvider to "%s" in cordis.patch.yml',
        provider.id,
      )
    }
  }

  ctx.logger?.info?.('cascade-search: ready (%s)', orderOf(config.order).join(' -> '))
}
