import { describe, expect, it } from '@jest/globals'
import { waitForApp } from '../src/commands/wait.js'

/** A client whose getApp always returns the same canned application. */
const clientReturning = (application) => ({ getApp: async () => application })

const opts = (extra) => ({
  timeoutSeconds: 0, // deadline = now, so the first poll trips the timeout
  forSync: false,
  forHealth: false,
  forOperation: true,
  log: () => {},
  ...extra
})

describe('waitForApp operation reason', () => {
  it('reports a merely queued operation as "pending", not its stale phase', async () => {
    const app = {
      operation: { sync: {} }, // a newly queued op
      status: {
        operationState: { phase: 'Succeeded' }, // phase of the *previous* op
        sync: { status: 'Synced' },
        health: { status: 'Healthy' }
      }
    }
    await expect(waitForApp(clientReturning(app), 'app', opts())).rejects.toThrow(
      /operation pending/
    )
    await expect(waitForApp(clientReturning(app), 'app', opts())).rejects.not.toThrow(
      /operation Succeeded/
    )
  })

  it('reports a live Running phase as-is', async () => {
    const app = {
      status: {
        operationState: { phase: 'Running' },
        sync: { status: 'Synced' },
        health: { status: 'Healthy' }
      }
    }
    await expect(waitForApp(clientReturning(app), 'app', opts())).rejects.toThrow(
      /operation Running/
    )
  })
})

describe('waitForApp Degraded fail-fast', () => {
  it('aborts immediately when health is Degraded and the operation has settled', async () => {
    const app = {
      status: {
        operationState: { phase: 'Succeeded' },
        sync: { status: 'Synced' },
        health: { status: 'Degraded' },
        resources: [
          { kind: 'Deployment', name: 'web', health: { status: 'Degraded', message: 'ImagePullBackOff' } }
        ]
      }
    }
    // A generous timeout: the abort must come from the Degraded check on the
    // first poll, not from the deadline.
    const promise = waitForApp(clientReturning(app), 'app', opts({ timeoutSeconds: 600, forHealth: true }))
    await expect(promise).rejects.toThrow(/Rollout Degraded for app/)
    await expect(promise).rejects.toThrow(/ImagePullBackOff/)
  })

  it('does not fail-fast on Degraded while a sync operation is still running', async () => {
    const app = {
      status: {
        operationState: { phase: 'Running' },
        sync: { status: 'Synced' },
        health: { status: 'Degraded' }
      }
    }
    // timeoutSeconds: 0 -> the deadline trips on the first poll, so we get the
    // timeout error (reasons include health=Degraded), not an early abort.
    const promise = waitForApp(clientReturning(app), 'app', opts({ forHealth: true }))
    await expect(promise).rejects.toThrow(/Timed out/)
    await expect(promise).rejects.not.toThrow(/Rollout Degraded/)
  })

  it('does not treat Degraded as terminal when wait-for-health is off', async () => {
    const app = {
      status: {
        operationState: { phase: 'Succeeded' },
        sync: { status: 'Synced' },
        health: { status: 'Degraded' }
      }
    }
    // forHealth: false and forOperation: false -> nothing left to wait on, so
    // the app is considered done rather than aborted for being Degraded.
    const status = await waitForApp(
      clientReturning(app),
      'app',
      opts({ timeoutSeconds: 600, forOperation: false, forHealth: false })
    )
    expect(status.healthStatus).toBe('Degraded')
  })
})
