import * as core from '@actions/core'

/**
 * Resolve a value from an action input first, then a list of environment
 * variables. Returns '' when nothing is set.
 */
function fromInputOrEnv(inputName, envNames = []) {
  const input = core.getInput(inputName)
  if (input) return input
  for (const env of envNames) {
    if (process.env[env]) return process.env[env]
  }
  return ''
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return /^(true|1|yes|on)$/i.test(String(value).trim())
}

/**
 * Parse a positive number from an input, falling back when the value is empty
 * or not a finite positive number. Guards against `Number('10m') === NaN`
 * silently producing a `NaN` deadline that never fires.
 */
function parseNumber(value, fallback) {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Normalize a server host into a base URL. Accepts "argocd.example.com",
 * "https://argocd.example.com", "argocd.example.com:443", etc.
 */
export function normalizeBaseUrl(server) {
  if (!server) return ''
  let s = server.trim()
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`
  }
  return s.replace(/\/+$/, '')
}

/**
 * Build the connection config shared by every command. Inputs win over the
 * standard ARGOCD_* environment variables that the argocd CLI also reads.
 */
export function resolveConfig() {
  const server = fromInputOrEnv('server', ['ARGOCD_SERVER'])
  if (!server) {
    throw new Error(
      'No ArgoCD server configured. Set the `server` input or the ARGOCD_SERVER env var.'
    )
  }

  const baseUrl = normalizeBaseUrl(server)
  const token = fromInputOrEnv('auth-token', ['ARGOCD_AUTH_TOKEN'])
  const username = fromInputOrEnv('username', ['ARGOCD_USERNAME'])
  const password = fromInputOrEnv('password', ['ARGOCD_PASSWORD'])

  const insecureInput = core.getInput('insecure')
  const insecure = parseBool(insecureInput || process.env.ARGOCD_INSECURE, false)

  const appNamespace = fromInputOrEnv('app-namespace', ['ARGOCD_APP_NAMESPACE'])

  // OIDC: exchange a GitHub Actions ID token for an ArgoCD token at /api/dex/token.
  const oidcAudience = core.getInput('oidc-audience')
  const oidcClientId = core.getInput('oidc-client-id') || 'argo-cd-cli'
  const oidcConnectorId = core.getInput('oidc-connector-id') || 'github-actions'

  const authMethod = resolveAuthMethod({ token, username, password })

  return {
    baseUrl,
    authMethod,
    token,
    username,
    password,
    insecure,
    appNamespace,
    oidcAudience,
    oidcClientId,
    oidcConnectorId
  }
}

/**
 * Decide which authentication flow to use. An explicit `auth-method` input wins;
 * otherwise it is inferred from the credentials that are present, preferring a
 * static token, then username/password, then OIDC when GitHub's ID-token
 * endpoint is available to the workflow.
 */
function resolveAuthMethod({ token, username, password }) {
  const explicit = core.getInput('auth-method').trim().toLowerCase()
  if (explicit) {
    if (!['token', 'password', 'oidc'].includes(explicit)) {
      throw new Error(
        `Invalid auth-method "${explicit}". Expected one of: token, password, oidc.`
      )
    }
    if (explicit === 'token' && !token) {
      throw new Error('auth-method is `token` but no `auth-token`/$ARGOCD_AUTH_TOKEN was provided.')
    }
    if (explicit === 'password' && !(username && password)) {
      throw new Error('auth-method is `password` but `username`/`password` were not both provided.')
    }
    if (explicit === 'oidc' && !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
      throw new Error(
        'auth-method is `oidc` but no GitHub ID token is available. Add `permissions: id-token: write` to the job.'
      )
    }
    return explicit
  }

  if (token) return 'token'
  if (username && password) return 'password'
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) return 'oidc'

  throw new Error(
    'No ArgoCD credentials configured. Provide `auth-token` (or $ARGOCD_AUTH_TOKEN), `username`/`password` (or $ARGOCD_USERNAME/$ARGOCD_PASSWORD), or run with `permissions: id-token: write` for OIDC.'
  )
}

export { parseBool, parseNumber }
