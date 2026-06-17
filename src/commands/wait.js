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

  return {
    syncStatus,
    healthStatus,
    opPhase,
    done: reasons.length === 0,
    reasons,
    operationFailed,
    operationMessage: status.operationState?.message
  }
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
  refresh,
  intervalMs = 3000,
  log = core.info,
  onPoll
} = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000
  let lastSummary = ''
  let firstPoll = true

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

    if (ev.operationFailed) {
      const detail = describeProblems(application).join('; ') || ev.operationMessage || ev.opPhase
      throw new Error(`Operation failed for ${app}: ${detail}`)
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
