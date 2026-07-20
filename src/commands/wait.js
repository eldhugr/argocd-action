import * as core from '@actions/core'
import { parseBool, parseNumber } from '../config.js'
import { sleep } from '../util.js'
import { appLink, code, escapeCell, fail, imagesCell, ok, table, writeSummary } from '../summary.js'

/** Evaluate whether the application currently satisfies the wait conditions. */
function evaluate(app, { forSync, forHealth, forOperation }) {
  const status = app.status || {}
  const syncStatus = status.sync?.status || 'Unknown'
  const healthStatus = status.health?.status || 'Unknown'
  const opPhase = status.operationState?.phase
  // `app.operation` is set while an operation is queued but not yet started.
  const operationPending =
    Boolean(app.operation) || opPhase === 'Running' || opPhase === 'Terminating'

  const reasons = []
  if (forOperation && operationPending) {
    // `opPhase` reflects the *last finished* operation while `app.operation`
    // holds a newly queued one, so only report a live phase; a queued op is
    // "pending" rather than the stale (e.g. "Succeeded") phase.
    const phase = opPhase === 'Running' || opPhase === 'Terminating' ? opPhase : 'pending'
    reasons.push(`operation ${phase}`)
  }
  if (forSync && syncStatus !== 'Synced') reasons.push(`sync=${syncStatus}`)
  if (forHealth && healthStatus !== 'Healthy') reasons.push(`health=${healthStatus}`)

  // Fail fast: a finished-but-failed operation will never satisfy the wait.
  const operationFailed =
    forOperation && (opPhase === 'Failed' || opPhase === 'Error') && !app.operation

  // Fail fast: `Degraded` means Kubernetes/ArgoCD has given up on the rollout
  // (e.g. a Deployment past its progressDeadlineSeconds, or a failing resource
  // health check) - it will not recover within this deploy, so don't burn the
  // rest of the timeout. Guarded on no in-flight operation, since a queued or
  // running sync may still flip the app back to Progressing.
  const healthDegraded = forHealth && healthStatus === 'Degraded' && !operationPending

  return {
    syncStatus,
    healthStatus,
    opPhase,
    operationPending,
    done: reasons.length === 0,
    reasons,
    operationFailed,
    healthDegraded,
    operationMessage: status.operationState?.message
  }
}

/**
 * Container "waiting"/pod reasons that mean a Pod will not start on its own,
 * mapped to how aggressively the wait aborts. `image`/`config` faults never
 * self-heal without a new push or a manifest fix, so they trip after a couple
 * of polls; `crash` (CrashLoopBackOff) is debounced longer, since a slowly
 * initialising container can flap through it before it settles.
 */
export const POD_FAIL_REASONS = {
  ImagePullBackOff: 'image',
  ErrImagePull: 'image',
  InvalidImageName: 'image',
  ErrImageNeverPull: 'image',
  CreateContainerConfigError: 'config',
  CreateContainerError: 'config',
  RunContainerError: 'config',
  CrashLoopBackOff: 'crash'
}

/** Consecutive polls a fault class must persist before it aborts the wait. */
export const POD_FAIL_THRESHOLD = { image: 2, config: 2, crash: 3 }

/**
 * Consecutive polls the app must stay `Degraded` before the wait aborts. The
 * debounce rides out a stale/lagging snapshot: right after a sync/restart the
 * API can briefly echo the *previous* deploy's Degraded state (informer lag)
 * before the new operation registers, and a bare `wait` may catch an app
 * mid-recovery.
 */
export const DEGRADED_POLL_THRESHOLD = 2

/**
 * How often (ms) the pod fail-fast fetches the (potentially large) resource
 * tree, throttled well below the poll interval so a long but healthy rollout
 * does not pull the whole tree on every poll. The first fetch is delayed by
 * this much as well, so a quick clean rollout that reaches Healthy first never
 * fetches the tree at all. A stuck rollout is still caught far inside the
 * timeout: image/config faults abort ~2 intervals after this delay.
 */
export const POD_CHECK_INTERVAL_MS = 15000

/**
 * Inspect one resource-tree node and, when it is a Pod stuck in an
 * unrecoverable state, return `{reason, cls}`. The reason keyword is matched
 * against every `info` value and the health message - ArgoCD surfaces
 * "ImagePullBackOff" et al. in one or the other depending on version, so we do
 * not depend on a single field name. A `Degraded` Pod with no recognised reason
 * falls back to the debounced `crash` class, but only when it is actually
 * restarting (see below) rather than terminal-but-replaced.
 */
export function podFailureReason(node) {
  if (node?.kind !== 'Pod') return null
  const info = node.info || []
  const haystacks = info.map((i) => i && i.value).filter(Boolean).map(String)
  if (node.health?.message) haystacks.push(String(node.health.message))
  for (const [reason, cls] of Object.entries(POD_FAIL_REASONS)) {
    if (haystacks.some((h) => h.includes(reason))) return { reason, cls }
  }
  // No named reason, but ArgoCD still calls the Pod Degraded (e.g. a container
  // terminated with a non-zero exit, or OOMKilled). Only treat it as a failure
  // when the container is genuinely restarting - a positive "Restart Count".
  // That excludes terminal-but-replaced pods (Evicted, preempted, node-lost)
  // that the controller simply recreates: those linger in the tree as Degraded
  // with zero restarts and would otherwise be a phantom, never-clearing abort.
  // A genuinely stuck rollout with no restarts is still caught by the app-level
  // `Degraded` health check, just not as early.
  if (node.health?.status === 'Degraded') {
    const restarts = Number(info.find((i) => i?.name === 'Restart Count')?.value)
    if (restarts > 0) {
      const statusReason = info.find((i) => i?.name === 'Status Reason')?.value
      return { reason: statusReason || node.health.message || 'Degraded', cls: 'crash' }
    }
  }
  return null
}

/** Collect every Pod node in the resource tree that is in an unrecoverable state. */
export function findPodFailures(tree) {
  const failures = []
  for (const node of tree?.nodes || []) {
    const f = podFailureReason(node)
    if (f) failures.push({ name: node.name, reason: f.reason, cls: f.cls })
  }
  return failures
}

/**
 * Collect human-readable problem descriptions from an application's status -
 * the operation message, app conditions, and any non-Healthy resources - so a
 * failure/timeout can report *why* rather than just the state.
 */
function describeProblems(application) {
  const problems = []
  const op = application.status?.operationState
  if (op?.message) problems.push(`operation: ${op.message}`)
  for (const c of application.status?.conditions || []) {
    if (c.message) problems.push(`${c.type || 'condition'}: ${c.message}`)
  }
  for (const r of application.status?.resources || []) {
    const h = r.health
    if (h?.status && h.status !== 'Healthy') {
      problems.push(`${r.kind}/${r.name} ${h.status}${h.message ? `: ${h.message}` : ''}`)
    }
  }
  return problems.slice(0, 5)
}

/**
 * Poll an application until it satisfies the wait conditions. Resolves with the
 * final status; throws on a failed operation or timeout. Reusable op shared by
 * the `wait` and `deploy` commands.
 *
 * @returns {Promise<{syncStatus: string, healthStatus: string, revision: string, images: string[], opPhase: string}>}
 */
export async function waitForApp(client, app, {
  timeoutSeconds = 600,
  forSync = true,
  forHealth = true,
  forOperation = true,
  failOnRolloutFailure = true,
  refresh,
  intervalMs = 3000,
  podCheckIntervalMs = POD_CHECK_INTERVAL_MS,
  log = core.info,
  onPoll
} = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000
  let lastSummary = ''
  let firstPoll = true
  // Pod name -> {reason, cls, count} of consecutive polls a fault has persisted,
  // for the debounce in the pod fail-fast below.
  let podSeen = new Map()
  // Consecutive polls the app has been `Degraded`, for the debounce below.
  let degradedPolls = 0
  // Timestamp of the last resource-tree fetch, to throttle it below the poll
  // interval. Seeded to now so the first fetch waits one podCheckIntervalMs.
  let lastPodCheck = Date.now()

  for (;;) {
    const application = await client.getApp(app, firstPoll && refresh && refresh !== 'false' ? { refresh } : {})
    firstPoll = false

    const ev = evaluate(application, { forSync, forHealth, forOperation })
    const status = {
      syncStatus: ev.syncStatus,
      healthStatus: ev.healthStatus,
      revision:
        application.status?.sync?.revision ||
        (application.status?.sync?.revisions || []).join(',') ||
        '',
      images: application.status?.summary?.images || [],
      opPhase: ev.opPhase
    }
    onPoll?.(status)

    const summary = `sync=${ev.syncStatus} health=${ev.healthStatus}${ev.opPhase ? ` operation=${ev.opPhase}` : ''}`
    if (summary !== lastSummary) {
      log(summary)
      lastSummary = summary
    }

    if (ev.done) {
      log(`Application ${app} reached the desired state.`)
      return status
    }

    // A finished-but-failed operation is a reliable terminal signal, so abort
    // at once.
    if (ev.operationFailed) {
      const detail = describeProblems(application).join('; ') || ev.operationMessage || ev.opPhase
      throw new Error(`Operation failed for ${app}: ${detail}`)
    }

    // A `Degraded` rollout is aborted too, but debounced - the health can be a
    // stale post-sync snapshot or a momentary blip (see DEGRADED_POLL_THRESHOLD).
    // ev.healthDegraded already resets to false while an operation is pending,
    // so a fresh sync clears the counter.
    degradedPolls = failOnRolloutFailure && ev.healthDegraded ? degradedPolls + 1 : 0
    if (degradedPolls >= DEGRADED_POLL_THRESHOLD) {
      const detail = describeProblems(application).join('; ') || ev.operationMessage || ev.opPhase
      throw new Error(`Rollout Degraded for ${app}: ${detail}`)
    }

    // Fail fast on a Pod that cannot start (bad image, missing config, crash
    // loop). For a Deployment such a Pod keeps the app "Progressing" right up to
    // progressDeadlineSeconds, so watching the resource tree catches it far
    // sooner. Like the `Degraded` check above this only applies when we are
    // actually waiting for health - a sync-only wait does not care about pod
    // readiness. Gated further to keep the (potentially large) tree fetch cheap:
    // only once the sync operation has settled (pods churn during it), never
    // while the app is already Healthy (nothing to find), and at most every
    // podCheckIntervalMs rather than every poll. Best-effort: a tree-fetch error
    // just skips the check this poll. The per-pod counter debounces blips.
    if (
      failOnRolloutFailure &&
      forHealth &&
      !ev.operationPending &&
      ev.healthStatus !== 'Healthy' &&
      Date.now() - lastPodCheck >= podCheckIntervalMs
    ) {
      lastPodCheck = Date.now()
      let tree
      try {
        tree = await client.getResourceTree(app)
      } catch (err) {
        log(`Skipping pod fail-fast this poll (resource tree unavailable: ${err instanceof Error ? err.message : err}).`)
      }
      if (tree) {
        const next = new Map()
        for (const f of findPodFailures(tree)) {
          const prev = podSeen.get(f.name)
          const count = prev && prev.reason === f.reason ? prev.count + 1 : 1
          next.set(f.name, { reason: f.reason, cls: f.cls, count })
        }
        podSeen = next
        const tripped = [...next.entries()].find(([, v]) => v.count >= (POD_FAIL_THRESHOLD[v.cls] || 3))
        if (tripped) {
          const [podName, v] = tripped
          const detail = describeProblems(application).join('; ')
          throw new Error(`Pod ${podName} for ${app} is not starting: ${v.reason}${detail ? ` - ${detail}` : ''}.`)
        }
      }
    }

    if (Date.now() >= deadline) {
      const problems = describeProblems(application)
      const extra = problems.length ? ` - ${problems.join('; ')}` : ''
      throw new Error(`Timed out after ${timeoutSeconds}s waiting for ${app} (${ev.reasons.join(', ')})${extra}.`)
    }

    await sleep(intervalMs)
  }
}

export async function run(client, app) {
  try {
    const status = await waitForApp(client, app, {
      timeoutSeconds: parseNumber(core.getInput('timeout'), 600),
      forSync: parseBool(core.getInput('wait-for-sync'), true),
      forHealth: parseBool(core.getInput('wait-for-health'), true),
      forOperation: parseBool(core.getInput('wait-for-operation'), true),
      failOnRolloutFailure: parseBool(core.getInput('fail-on-rollout-failure'), true),
      refresh: core.getInput('refresh'),
      onPoll: (s) => {
        core.setOutput('sync-status', s.syncStatus)
        core.setOutput('health-status', s.healthStatus)
        core.setOutput('revision', s.revision)
      }
    })
    await writeSummary('ArgoCD Wait', [
      `**${code(app)} is ${status.syncStatus} and ${status.healthStatus}.**`,
      '',
      table(
        ['Application', 'Result', 'Sync', 'Health', 'Details'],
        [[appLink(app, client), ok('Ready'), status.syncStatus, status.healthStatus, imagesCell(status.images)]]
      )
    ])
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await writeSummary('ArgoCD Wait', [
      `**${code(app)} did not reach the desired state.**`,
      '',
      table(
        ['Application', 'Result', 'Sync', 'Health', 'Details'],
        [[appLink(app, client), fail('Not ready'), '', '', escapeCell(reason)]]
      )
    ])
    throw err
  }
}
