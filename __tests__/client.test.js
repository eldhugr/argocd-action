import { jest, describe, expect, it, afterEach } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { ArgoClient, retryAfterMs } = await import('../src/client.js')

/** A response stub carrying a single `Retry-After` header value. */
const withRetryAfter = (value) => ({ headers: { get: (k) => (k === 'retry-after' ? value : null) } })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** A minimal Response-like stub. */
function resp(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  }
}

/** A client with fast, bounded retries so tests don't sleep for long. */
function client(opts = {}) {
  return new ArgoClient({
    baseUrl: 'https://argo.example',
    token: 't',
    maxRetries: 2,
    retryBaseMs: 1,
    timeoutMs: 50,
    ...opts
  })
}

describe('ArgoClient request resilience', () => {
  it('retries an idempotent GET on a transient 503, then succeeds', async () => {
    let n = 0
    globalThis.fetch = jest.fn(async () => (++n < 3 ? resp(503) : resp(200, { healthy: true })))
    await expect(client().getApp('app')).resolves.toEqual({ healthy: true })
    expect(globalThis.fetch).toHaveBeenCalledTimes(3) // two 503s + success
  })

  it('retries a POST sync on a gateway 502 (request never reached the backend)', async () => {
    let n = 0
    globalThis.fetch = jest.fn(async () => (++n < 2 ? resp(502) : resp(200, {})))
    await client().sync('app', { prune: true })
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('retries an idempotent GET on a network error, then succeeds', async () => {
    let n = 0
    globalThis.fetch = jest.fn(async () => {
      if (++n < 2) throw new Error('network blip')
      return resp(200, { ok: 1 })
    })
    await client().getApp('app')
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry a POST on a network error (non-idempotent)', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('ECONNRESET')
    })
    await expect(client().sync('app')).rejects.toThrow('ECONNRESET')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry a non-transient 404 and surfaces the error', async () => {
    globalThis.fetch = jest.fn(async () => resp(404, { message: 'not found' }))
    await expect(client().getApp('missing')).rejects.toThrow(/failed \(404\): not found/)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('attaches the HTTP status to the thrown error so callers can classify it', async () => {
    globalThis.fetch = jest.fn(async () => resp(403, { message: 'permission denied' }))
    // 403 is what ArgoCD returns for a missing app (and a real RBAC denial); the
    // caller distinguishes by `status` rather than parsing the message.
    await expect(client().getApp('missing')).rejects.toMatchObject({
      name: 'ArgoApiError',
      status: 403
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxRetries and surfaces the last transient status', async () => {
    globalThis.fetch = jest.fn(async () => resp(503, { message: 'unavailable' }))
    await expect(client({ maxRetries: 2 }).getApp('app')).rejects.toThrow(/failed \(503\)/)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('aborts a hung request once the per-request timeout elapses', async () => {
    globalThis.fetch = jest.fn(
      (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
    )
    await expect(client({ timeoutMs: 20, maxRetries: 0 }).getApp('app')).rejects.toThrow(/timed out after 20ms/)
  })
})

describe('retryAfterMs', () => {
  it('returns 0 when the header is absent', () => {
    expect(retryAfterMs({ headers: { get: () => null } })).toBe(0)
  })

  it('parses a delta-seconds value', () => {
    expect(retryAfterMs(withRetryAfter('2'))).toBe(2000)
  })

  it('ignores a non-positive delta', () => {
    expect(retryAfterMs(withRetryAfter('0'))).toBe(0)
  })

  it('parses an HTTP-date in the future', () => {
    const when = new Date(Date.now() + 30000).toUTCString()
    const ms = retryAfterMs(withRetryAfter(when))
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(30000)
  })

  it('treats a past HTTP-date as no delay', () => {
    const when = new Date(Date.now() - 30000).toUTCString()
    expect(retryAfterMs(withRetryAfter(when))).toBe(0)
  })

  it('ignores an unparseable value', () => {
    expect(retryAfterMs(withRetryAfter('soon'))).toBe(0)
  })

  it('caps an absurdly large delay', () => {
    expect(retryAfterMs(withRetryAfter('999999'))).toBe(10000)
  })
})
