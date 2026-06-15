/**
 * Disable TLS certificate verification process-wide. Used for the `insecure`
 * option; relies on the action running in its own short-lived process. Avoids a
 * dependency on undici just to pass a custom dispatcher to `fetch`.
 */
function disableTlsVerification() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

/**
 * Thin client over the ArgoCD REST gateway (the same HTTP API the argocd CLI
 * talks to via grpc-web). All calls hit `${baseUrl}/api/v1/...` and authenticate
 * with a Bearer token.
 */
export class ArgoClient {
  constructor({ baseUrl, token, insecure = false, appNamespace = '' }) {
    this.baseUrl = baseUrl
    this.token = token
    this.appNamespace = appNamespace
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
      scope: 'openid email profile federated:id',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
    })
    // `--user argo-cd-cli:` → HTTP Basic auth with an empty secret.
    const basic = Buffer.from(`${clientId}:`).toString('base64')

    const res = await fetch(`${baseUrl}/api/dex/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    })
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
    const res = await fetch(`${baseUrl}/api/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
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

    const res = await fetch(url, { method, headers, body: payload })

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
