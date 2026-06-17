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
