import * as core from '@actions/core'
import { sleep } from './util.js'

/**
 * Disable TLS certificate verification process-wide. Used for the `insecure`
 * option; relies on the action running in its own short-lived process. Avoids a
 * dependency on undici just to pass a custom dispatcher to `fetch`.
 */
function disableTlsVerification() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

// --- Request resilience (timeout + bounded retry) --------------------------

/** Per-request timeout and retry defaults for the ArgoCD HTTP gateway. */
const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_MS = 500
const RETRY_CAP_MS = 5000

/**
 * Gateway/overload statuses that mean the request almost certainly never reached
 * (or was rejected before) the ArgoCD backend, so they are safe to retry for any
 * method. 500 is ambiguous and only retried for idempotent methods.
 */
const ALWAYS_RETRY_STATUS = new Set([429, 502, 503, 504])

/** GET/PUT/DELETE are idempotent - safe to retry on a transport error too. */
function isIdempotent(method) {
  return method === 'GET' || method === 'PUT' || method === 'DELETE' || method === 'HEAD'
}

function isRetryableStatus(status, idempotent) {
  if (ALWAYS_RETRY_STATUS.has(status)) return true
  return idempotent && status === 500
}

/** Exponential backoff with mild jitter, capped at RETRY_CAP_MS. */
function backoffDelay(attempt, base) {
  const exp = Math.min(RETRY_CAP_MS, base * 2 ** attempt)
  return exp + Math.floor(Math.random() * 250)
}

/**
 * Honour a `Retry-After` header, capped so it can't stall the job. Accepts both
 * forms HTTP allows: a delta in seconds (`120`) or an HTTP-date
 * (`Wed, 21 Oct 2015 07:28:00 GMT`).
 */
export function retryAfterMs(res) {
  const header = res.headers?.get?.('retry-after')
  if (!header) return 0
  const cap = 2 * RETRY_CAP_MS
  const secs = Number(header)
  if (Number.isFinite(secs)) {
    return secs > 0 ? Math.min(cap, secs * 1000) : 0
  }
  const when = Date.parse(header)
  if (Number.isNaN(when)) return 0
  const delta = when - Date.now()
  return delta > 0 ? Math.min(cap, delta) : 0
}

/** fetch() with an AbortController deadline; rejects with AbortError on timeout. */
async function fetchWithTimeout(url, init, timeoutMs) {
  if (!timeoutMs) return fetch(url, init)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * fetch() wrapper adding a per-request timeout and a bounded, backed-off retry on
 * transient failures: gateway 5xx/429 for any method, plus timeouts and network
 * errors for idempotent methods. Returns the final Response (the caller formats
 * non-ok bodies into errors); throws only on a transport error it won't retry.
 */
async function fetchWithRetry(url, init, opts = {}) {
  const {
    method = 'GET',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    label
  } = opts
  const idempotent = isIdempotent(method)
  const what = label || `${method} ${url}`
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetchWithTimeout(url, init, timeoutMs)
    } catch (err) {
      const timedOut = err && err.name === 'AbortError'
      if (idempotent && attempt < maxRetries) {
        const delay = backoffDelay(attempt, retryBaseMs)
        core.info(`ArgoCD ${what} ${timedOut ? `timed out after ${timeoutMs}ms` : `request error (${err.message})`}; retrying in ${delay}ms (${attempt + 1}/${maxRetries}).`)
        await sleep(delay)
        continue
      }
      if (timedOut) throw new Error(`ArgoCD ${what} timed out after ${timeoutMs}ms.`)
      throw err
    }
    if (res.ok) return res
    if (isRetryableStatus(res.status, idempotent) && attempt < maxRetries) {
      const delay = Math.max(backoffDelay(attempt, retryBaseMs), retryAfterMs(res))
      core.info(`ArgoCD ${what} returned ${res.status}; retrying in ${delay}ms (${attempt + 1}/${maxRetries}).`)
      await sleep(delay)
      continue
    }
    return res
  }
}

/**
 * Thin client over the ArgoCD REST gateway (the same HTTP API the argocd CLI
 * talks to via grpc-web). All calls hit `${baseUrl}/api/v1/...` and authenticate
 * with a Bearer token.
 */
export class ArgoClient {
  constructor({
    baseUrl,
    token,
    insecure = false,
    appNamespace = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBaseMs = DEFAULT_RETRY_BASE_MS
  }) {
    this.baseUrl = baseUrl
    this.token = token
    this.appNamespace = appNamespace
    this.timeoutMs = timeoutMs
    this.maxRetries = maxRetries
    this.retryBaseMs = retryBaseMs
    if (insecure) disableTlsVerification()
  }

  /**
   * Exchange a GitHub Actions OIDC ID token for an ArgoCD access token via the
   * Dex token-exchange endpoint, and return a client using it. Mirrors the
   * `curl .../api/dex/token` flow from the ArgoCD GitHub Actions docs, done
   * natively so no `curl`/`jq`/`argocd` CLI is required.
   */
  static async loginOidc({
    baseUrl,
    idToken,
    clientId = 'argo-cd-cli',
    connectorId = 'github-actions',
    insecure = false,
    appNamespace = ''
  }) {
    if (insecure) disableTlsVerification()
    if (!idToken) throw new Error('OIDC login requires a GitHub ID token.')

    const params = new URLSearchParams({
      connector_id: connectorId,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      scope: 'openid email profile groups federated:id',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
    })
    // `--user argo-cd-cli:` → HTTP Basic auth with an empty secret.
    const basic = Buffer.from(`${clientId}:`).toString('base64')

    const res = await fetchWithRetry(
      `${baseUrl}/api/dex/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      },
      { method: 'POST', label: 'POST /api/dex/token' }
    )
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`OIDC token exchange failed (${res.status}): ${body}`)
    }
    const data = await res.json()
    if (!data.access_token) {
      throw new Error('OIDC token exchange succeeded but no access_token was returned.')
    }
    return new ArgoClient({ baseUrl, token: data.access_token, insecure, appNamespace })
  }

  /** Obtain a session token from username/password and return a client using it. */
  static async login({ baseUrl, username, password, insecure = false, appNamespace = '' }) {
    if (insecure) disableTlsVerification()
    const res = await fetchWithRetry(
      `${baseUrl}/api/v1/session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      },
      { method: 'POST', label: 'POST /api/v1/session' }
    )
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Login failed (${res.status}): ${body}`)
    }
    const data = await res.json()
    if (!data.token) {
      throw new Error('Login succeeded but no token was returned.')
    }
    return new ArgoClient({ baseUrl, token: data.token, insecure, appNamespace })
  }

  async request(method, path, { query = {}, body } = {}) {
    const url = new URL(`${this.baseUrl}/api/v1${path}`)
    // Inject appNamespace by default unless the caller already supplied it.
    // Build a local copy so the caller's `query` object is never mutated.
    const params = { ...query }
    if (this.appNamespace && !('appNamespace' in params)) {
      params.appNamespace = this.appNamespace
    }
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v))
      }
    }

    const headers = { Authorization: `Bearer ${this.token}` }
    let payload
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }

    const res = await fetchWithRetry(
      url,
      { method, headers, body: payload },
      {
        method,
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        retryBaseMs: this.retryBaseMs,
        label: `${method} ${path}`
      }
    )

    const text = await res.text()
    if (!res.ok) {
      let message = text
      try {
        const parsed = JSON.parse(text)
        message = parsed.message || parsed.error || text
      } catch {
        // keep raw text
      }
      throw new Error(`ArgoCD API ${method} ${path} failed (${res.status}): ${message}`)
    }
    return text ? JSON.parse(text) : {}
  }

  // --- Application endpoints -------------------------------------------------

  getApp(name, { refresh } = {}) {
    const query = {}
    if (refresh && refresh !== 'false') query.refresh = refresh
    return this.request('GET', `/applications/${encodeURIComponent(name)}`, { query })
  }

  updateSpec(name, spec, { validate } = {}) {
    const query = {}
    if (validate !== undefined) query.validate = validate
    return this.request('PUT', `/applications/${encodeURIComponent(name)}/spec`, { query, body: spec })
  }

  getManagedResources(name) {
    return this.request('GET', `/applications/${encodeURIComponent(name)}/managed-resources`)
  }

  sync(name, body = {}) {
    const payload = { name, ...body }
    if (this.appNamespace) payload.appNamespace = this.appNamespace
    return this.request('POST', `/applications/${encodeURIComponent(name)}/sync`, { body: payload })
  }

  /** Roll an application back to a previous deployment history entry (by id). */
  rollback(name, { id, prune = false, dryRun = false } = {}) {
    const payload = { name, id }
    if (prune) payload.prune = true
    if (dryRun) payload.dryRun = true
    if (this.appNamespace) payload.appNamespace = this.appNamespace
    return this.request('POST', `/applications/${encodeURIComponent(name)}/rollback`, { body: payload })
  }

  /** Terminate the application's currently running sync operation. */
  terminateOperation(name) {
    return this.request('DELETE', `/applications/${encodeURIComponent(name)}/operation`)
  }

  /**
   * Run a named resource action (e.g. "restart") on a single managed resource.
   * Mirrors `argocd app actions run`.
   */
  runResourceAction(name, { group = '', version = 'v1', kind, namespace = '', resourceName, action }) {
    const body = { name, group, version, kind, namespace, resourceName, action }
    if (this.appNamespace) body.appNamespace = this.appNamespace
    return this.request('POST', `/applications/${encodeURIComponent(name)}/resource/actions/v2`, { body })
  }
}
