import { describe, expect, it } from '@jest/globals'
import { findPodFailures, podFailureReason, waitForApp } from '../src/commands/wait.js'

/** A client whose getApp always returns the same canned application. */
const clientReturning = (application) => ({ getApp: async () => application })

/**
 * A client that walks a list of `{app, tree}` states, one per poll. `getApp`
 * reads the current state; `getResourceTree` reads it then advances. A `tree`
 * that is an Error is thrown, to exercise the best-effort tree read.
 */
const clientPolling = (states) => {
  let i = 0
  const at = () => states[Math.min(i, states.length - 1)]
  return {
    getApp: async () => at().app,
    getResourceTree: async () => {
      const { tree } = at()
      i += 1
      if (tree instanceof Error) throw tree
      return tree
    }
  }
}

/** A Progressing app with a settled (Succeeded) operation - pod fail-fast is active. */
const progressing = {
  status: {
    operationState: { phase: 'Succeeded' },
    sync: { status: 'Synced' },
    health: { status: 'Progressing' }
  }
}
const healthy = {
  status: {
    operationState: { phase: 'Succeeded' },
    sync: { status: 'Synced' },
    health: { status: 'Healthy' }
  }
}
const podTree = (name, reason) => ({
  nodes: [
    { kind: 'Pod', name, info: [{ name: 'Status Reason', value: reason }], health: { status: 'Degraded' } }
  ]
})

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
  const degraded = {
    status: {
      operationState: { phase: 'Succeeded' },
      sync: { status: 'Synced' },
      health: { status: 'Degraded' },
      resources: [
        { kind: 'Deployment', name: 'web', health: { status: 'Degraded', message: 'ImagePullBackOff' } }
      ]
    }
  }
  // A client stuck Degraded, with an empty resource tree so only the app-level
  // Degraded check (not the pod check) can fire.
  const stuckDegraded = { getApp: async () => degraded, getResourceTree: async () => ({ nodes: [] }) }

  it('aborts once Degraded persists past the debounce', async () => {
    // A generous timeout: the abort must come from the Degraded check, not the
    // deadline. intervalMs: 1 so the debounce polls elapse near-instantly.
    const promise = waitForApp(stuckDegraded, 'app', opts({ timeoutSeconds: 600, intervalMs: 1, forHealth: true }))
    await expect(promise).rejects.toThrow(/Rollout Degraded for app/)
    await expect(promise).rejects.toThrow(/ImagePullBackOff/)
  })

  it('does not abort a Degraded blip that clears within the debounce window', async () => {
    // Degraded on the first poll, Healthy on the next - the counter resets
    // before it reaches the threshold, so the app is considered done. The app
    // state advances on getApp (not the throttled tree fetch).
    const apps = [degraded, healthy]
    let i = 0
    const client = {
      getApp: async () => apps[Math.min(i++, apps.length - 1)],
      getResourceTree: async () => ({ nodes: [] })
    }
    const status = await waitForApp(client, 'app', opts({ timeoutSeconds: 600, intervalMs: 1, forHealth: true }))
    expect(status.healthStatus).toBe('Healthy')
  })

  it('does not fail-fast on Degraded when fail-on-rollout-failure is off', async () => {
    // The unified switch gates the Degraded abort too; getResourceTree must not
    // be reached either (the pod check shares the switch).
    const client = {
      getApp: async () => degraded,
      getResourceTree: async () => {
        throw new Error('should not be called when fail-on-rollout-failure is off')
      }
    }
    // timeoutSeconds: 0 -> times out on the first poll instead of aborting.
    const promise = waitForApp(client, 'app', opts({ forHealth: true, failOnRolloutFailure: false }))
    await expect(promise).rejects.toThrow(/Timed out/)
    await expect(promise).rejects.not.toThrow(/Rollout Degraded/)
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

describe('podFailureReason / findPodFailures', () => {
  it('detects an image fault from a Pod info value', () => {
    const node = { kind: 'Pod', name: 'p', info: [{ name: 'Status Reason', value: 'ImagePullBackOff' }] }
    expect(podFailureReason(node)).toEqual({ reason: 'ImagePullBackOff', cls: 'image' })
  })

  it('detects a crash fault and classifies it for the longer debounce', () => {
    const node = { kind: 'Pod', name: 'p', info: [{ name: 'Status Reason', value: 'CrashLoopBackOff' }] }
    expect(podFailureReason(node)).toEqual({ reason: 'CrashLoopBackOff', cls: 'crash' })
  })

  it('matches the reason from the health message when info lacks it', () => {
    const node = { kind: 'Pod', name: 'p', health: { status: 'Degraded', message: 'x: CreateContainerConfigError' } }
    expect(podFailureReason(node)).toEqual({ reason: 'CreateContainerConfigError', cls: 'config' })
  })

  it('matches the info reason even when the health message is the verbose back-off text', () => {
    // ArgoCD puts the token in "Status Reason"; health.message is the verbose
    // back-off text and does not contain it.
    const node = {
      kind: 'Pod',
      name: 'web-6f9c4d8b7-abcde',
      health: { status: 'Degraded', message: 'back-off 2m40s restarting failed container=web pod=web-6f9c4d8b7-abcde_ns(...)' },
      info: [
        { name: 'Status Reason', value: 'CrashLoopBackOff' },
        { name: 'Restart Count', value: '5' }
      ]
    }
    expect(podFailureReason(node)).toEqual({ reason: 'CrashLoopBackOff', cls: 'crash' })
  })

  it('falls back to the Status Reason info for an unrecognised, restarting Degraded Pod', () => {
    const node = {
      kind: 'Pod',
      name: 'p',
      health: { status: 'Degraded', message: 'back-off restarting failed container=...' },
      info: [
        { name: 'Status Reason', value: 'OOMKilled' },
        { name: 'Restart Count', value: '4' }
      ]
    }
    // Prefers the concise Status Reason over the verbose health message.
    expect(podFailureReason(node)).toEqual({ reason: 'OOMKilled', cls: 'crash' })
  })

  it('falls back to the health message for a restarting Degraded Pod with no Status Reason', () => {
    const node = {
      kind: 'Pod',
      name: 'p',
      health: { status: 'Degraded', message: 'container terminated with exit code 137' },
      info: [{ name: 'Restart Count', value: '2' }]
    }
    expect(podFailureReason(node)).toEqual({ reason: 'container terminated with exit code 137', cls: 'crash' })
  })

  it('ignores a terminal Degraded Pod that is not restarting (e.g. Evicted, preempted)', () => {
    // An Evicted/preempted pod lingers in the tree as Degraded with zero
    // restarts; the controller replaces it, so it must not trip the abort.
    const evicted = { kind: 'Pod', name: 'p', health: { status: 'Degraded', message: 'Evicted' } }
    expect(podFailureReason(evicted)).toBeNull()
    const zeroRestarts = {
      kind: 'Pod',
      name: 'p',
      health: { status: 'Degraded', message: 'Evicted' },
      info: [{ name: 'Status Reason', value: 'Evicted' }, { name: 'Restart Count', value: '0' }]
    }
    expect(podFailureReason(zeroRestarts)).toBeNull()
  })

  it('ignores healthy pods and non-Pod nodes', () => {
    expect(podFailureReason({ kind: 'Pod', name: 'p', health: { status: 'Healthy' } })).toBeNull()
    expect(podFailureReason({ kind: 'ReplicaSet', name: 'r', health: { status: 'Degraded' } })).toBeNull()
    const tree = {
      nodes: [
        { kind: 'Deployment', name: 'web', health: { status: 'Degraded' } },
        { kind: 'Pod', name: 'web-ok', health: { status: 'Healthy' } },
        { kind: 'Pod', name: 'web-bad', info: [{ name: 'Status Reason', value: 'ImagePullBackOff' }] }
      ]
    }
    expect(findPodFailures(tree)).toEqual([{ name: 'web-bad', reason: 'ImagePullBackOff', cls: 'image' }])
  })
})

describe('waitForApp pod fail-fast', () => {
  // podCheckIntervalMs: 0 disables the tree-fetch throttle so each poll checks
  // the tree, keeping these debounce assertions about poll counts.
  const podOpts = (extra) =>
    opts({
      timeoutSeconds: 600,
      intervalMs: 1,
      podCheckIntervalMs: 0,
      forHealth: true,
      forOperation: true,
      ...extra
    })

  it('aborts on an image fault once it persists past the debounce', async () => {
    const client = clientPolling([
      { app: progressing, tree: podTree('web-abc', 'ImagePullBackOff') },
      { app: progressing, tree: podTree('web-abc', 'ImagePullBackOff') }
    ])
    const promise = waitForApp(client, 'app', podOpts())
    await expect(promise).rejects.toThrow(/web-abc.*not starting: ImagePullBackOff/)
  })

  it('does not abort a crash loop that clears within the debounce window', async () => {
    const client = clientPolling([
      { app: progressing, tree: podTree('web-1', 'CrashLoopBackOff') },
      { app: progressing, tree: podTree('web-1', 'CrashLoopBackOff') },
      { app: healthy, tree: { nodes: [] } } // recovered before the crash threshold (3)
    ])
    const status = await waitForApp(client, 'app', podOpts())
    expect(status.healthStatus).toBe('Healthy')
  })

  it('aborts a crash loop that persists past its (longer) debounce', async () => {
    const client = clientPolling([
      { app: progressing, tree: podTree('web-2', 'CrashLoopBackOff') },
      { app: progressing, tree: podTree('web-2', 'CrashLoopBackOff') },
      { app: progressing, tree: podTree('web-2', 'CrashLoopBackOff') }
    ])
    const promise = waitForApp(client, 'app', podOpts())
    await expect(promise).rejects.toThrow(/web-2.*not starting: CrashLoopBackOff/)
  })

  it('is best-effort: a resource-tree read error just skips that poll', async () => {
    const client = clientPolling([
      { app: progressing, tree: new Error('rpc unavailable') },
      { app: progressing, tree: podTree('web-3', 'ImagePullBackOff') },
      { app: progressing, tree: podTree('web-3', 'ImagePullBackOff') }
    ])
    const promise = waitForApp(client, 'app', podOpts())
    await expect(promise).rejects.toThrow(/ImagePullBackOff/)
    await expect(promise).rejects.not.toThrow(/rpc unavailable/)
  })

  it('does not watch pods while a sync operation is still running', async () => {
    const app = {
      status: {
        operationState: { phase: 'Running' },
        sync: { status: 'Synced' },
        health: { status: 'Progressing' }
      }
    }
    // getResourceTree would throw if called; the operationPending guard must
    // skip it, so the run ends at the (zero) deadline instead.
    const client = {
      getApp: async () => app,
      getResourceTree: async () => {
        throw new Error('should not be called while operation is running')
      }
    }
    const promise = waitForApp(client, 'app', opts({ forHealth: true }))
    await expect(promise).rejects.toThrow(/Timed out/)
  })

  it('delays the first resource-tree fetch by podCheckIntervalMs', async () => {
    let calls = 0
    const client = {
      getApp: async () => progressing,
      getResourceTree: async () => {
        calls += 1
        return { nodes: [] }
      }
    }
    // A large throttle plus an immediate deadline: the first poll trips the
    // timeout before the grace window elapses, so the tree is never fetched.
    const promise = waitForApp(
      client,
      'app',
      opts({ timeoutSeconds: 0, forHealth: true, podCheckIntervalMs: 100000 })
    )
    await expect(promise).rejects.toThrow(/Timed out/)
    expect(calls).toBe(0)
  })

  it('does not fetch the resource tree while the app is Healthy', async () => {
    let calls = 0
    const app = {
      status: {
        operationState: { phase: 'Succeeded' },
        sync: { status: 'OutOfSync' },
        health: { status: 'Healthy' }
      }
    }
    const client = {
      getApp: async () => app,
      getResourceTree: async () => {
        calls += 1
        return { nodes: [] }
      }
    }
    // Waiting for both sync and health; health is Healthy so there are no
    // failing pods to find. forHealth: true and podCheckIntervalMs: 0 rule out
    // the other two skips - the Healthy skip is what keeps the tree unfetched.
    const promise = waitForApp(
      client,
      'app',
      opts({ timeoutSeconds: 0, forSync: true, forHealth: true, podCheckIntervalMs: 0 })
    )
    await expect(promise).rejects.toThrow(/Timed out/)
    expect(calls).toBe(0)
  })

  it('does not watch pods when wait-for-health is off', async () => {
    let calls = 0
    // Not Healthy and past the operation, so only the forHealth gate can stop
    // the pod check. Waiting on sync keeps the loop going to the deadline.
    const app = {
      status: {
        operationState: { phase: 'Succeeded' },
        sync: { status: 'OutOfSync' },
        health: { status: 'Degraded' }
      }
    }
    const client = {
      getApp: async () => app,
      getResourceTree: async () => {
        calls += 1
        return { nodes: [] }
      }
    }
    const promise = waitForApp(
      client,
      'app',
      opts({ timeoutSeconds: 0, forSync: true, forHealth: false, podCheckIntervalMs: 0 })
    )
    await expect(promise).rejects.toThrow(/Timed out/)
    await expect(promise).rejects.not.toThrow(/not starting/)
    expect(calls).toBe(0)
  })
})
