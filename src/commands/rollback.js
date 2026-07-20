import * as core from '@actions/core'
import { parseBool, parseNumber } from '../config.js'
import { waitForApp } from './wait.js'
import { appLink, code, imagesCell, ok, table, writeSummary } from '../summary.js'

/**
 * Resolve which deployment-history id to roll back to. Mirrors
 * `argocd app rollback <app> [ID]`:
 *   - explicit `id`        → that history entry
 *   - explicit `revision`  → the most recent history entry for that revision
 *   - neither              → the previous deployment (second-newest entry)
 *
 * @param {Array<{id:number,revision:string}>} history `status.history`
 * @returns {number} the history id to roll back to
 */
export function resolveRollbackId(history, { id = '', revision = '' } = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error('Application has no deployment history to roll back to.')
  }
  // Newest first.
  const sorted = [...history].sort((a, b) => Number(b.id) - Number(a.id))

  if (id !== '' && id !== undefined && id !== null) {
    const target = Number(id)
    if (!sorted.some((h) => Number(h.id) === target)) {
      throw new Error(`No deployment history entry with id ${id}.`)
    }
    return target
  }

  if (revision) {
    const match = sorted.find((h) => h.revision === revision)
    if (!match) {
      throw new Error(`No deployment history entry for revision ${revision}.`)
    }
    return Number(match.id)
  }

  if (sorted.length < 2) {
    throw new Error('No previous deployment to roll back to (only one history entry).')
  }
  return Number(sorted[1].id)
}

export async function run(client, app) {
  const dryRun = parseBool(core.getInput('dry-run'), false)
  const prune = parseBool(core.getInput('prune'), false)

  const application = await client.getApp(app)
  const id = resolveRollbackId(application.status?.history, {
    id: core.getInput('rollback-id').trim(),
    revision: core.getInput('revision').trim()
  })

  core.info(`Rolling back ${app} to deployment ${id}${dryRun ? ' (dry-run)' : ''}...`)
  await client.rollback(app, { id, prune, dryRun })

  if (dryRun) {
    core.info(`Dry-run rollback requested for ${app}; not waiting.`)
    await writeSummary('ArgoCD Rollback', [
      `**Dry-run rollback to deployment ${id} previewed for ${appLink(app, client)}; cluster unchanged.**`
    ])
    return
  }

  const status = await waitForApp(client, app, {
    timeoutSeconds: parseNumber(core.getInput('timeout'), 600),
    forSync: parseBool(core.getInput('wait-for-sync'), true),
    forHealth: parseBool(core.getInput('wait-for-health'), true),
    forOperation: parseBool(core.getInput('wait-for-operation'), true),
    failOnRolloutFailure: parseBool(core.getInput('fail-on-rollout-failure'), true),
    refresh: 'normal'
  })
  core.setOutput('sync-status', status.syncStatus)
  core.setOutput('health-status', status.healthStatus)
  core.setOutput('revision', status.revision)

  await writeSummary('ArgoCD Rollback', [
    `**${code(app)} rolled back to deployment ${id}.**`,
    '',
    table(
      ['Application', 'Result', 'Sync', 'Health', 'Details'],
      [[appLink(app, client), ok(`Rolled back (#${id})`), status.syncStatus, status.healthStatus, imagesCell(status.images)]]
    )
  ])
}
