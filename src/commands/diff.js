import * as core from '@actions/core'
import { diffManagedResources } from '../diff.js'
import { parseBool } from '../config.js'
import { sleep, resourceId } from '../util.js'
import { appLink, code, table, writeSummary } from '../summary.js'

const REFRESH_ANNOTATION = 'argocd.argoproj.io/refresh'

/**
 * Trigger a refresh and wait until the controller has cleared the refresh
 * annotation, so managed-resources reflects the freshly reconciled state.
 */
async function refreshAndWait(client, app, refresh, { timeoutMs = 60000, intervalMs = 2000, log = core.info } = {}) {
  await client.getApp(app, { refresh })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const application = await client.getApp(app)
    const annotations = application.metadata?.annotations || {}
    if (!annotations[REFRESH_ANNOTATION]) return
    await sleep(intervalMs)
  }
  log(`Refresh did not complete within ${Math.round(timeoutMs / 1000)}s; diffing current state anyway.`)
}

/**
 * Refresh (optionally) and compute the live-vs-target diff for an application.
 * Reusable op shared by the `diff` and `deploy` commands.
 *
 * @returns {Promise<{hasDiff: boolean, resources: object[]}>}
 */
export async function computeDiff(client, app, { refresh = 'normal', log = core.info } = {}) {
  if (refresh && refresh !== 'false') {
    log(`Refreshing ${app} (${refresh})...`)
    await refreshAndWait(client, app, refresh, { log })
  }
  const managed = await client.getManagedResources(app)
  return diffManagedResources(managed.items || [])
}

/** Emit a human-readable summary of a computeDiff() result. */
export function logDiff(app, { hasDiff, resources }, log = core.info) {
  const changed = resources.filter((r) => r.changed)
  if (!hasDiff) {
    log(`No differences for ${app}.`)
    return
  }
  log(`Found differences in ${changed.length} resource(s) for ${app}:`)
  for (const r of changed) {
    log(`  ${r.status.padEnd(8)} ${resourceId(r)}`)
    for (const p of r.paths.slice(0, 25)) {
      log(`      ${p.type}: ${p.path}`)
    }
    if (r.paths.length > 25) {
      log(`      ... and ${r.paths.length - 25} more`)
    }
  }
}

export async function run(client, app) {
  const refresh = core.getInput('refresh') || 'normal'
  const failOnDiff = parseBool(core.getInput('fail-on-diff'), false)

  const result = await computeDiff(client, app, { refresh })
  logDiff(app, result)

  core.setOutput('diff', String(result.hasDiff))

  await reportDiff(client, app, result)

  if (result.hasDiff && failOnDiff) {
    core.setFailed(`Application ${app} has differences.`)
  }

  return result.hasDiff
}

/** Title-case a diff status token (`modified` -> `Modified`). */
function statusLabel(status) {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : ''
}

/** Write the diff result to the GitHub step summary. */
async function reportDiff(client, app, result) {
  if (!result.hasDiff) {
    await writeSummary('ArgoCD Diff', [`**No differences for ${appLink(app, client)}.**`])
    return
  }
  const changed = result.resources.filter((r) => r.changed)
  const plural = changed.length === 1 ? 'resource' : 'resources'
  const rows = changed.map((r) => [
    code(resourceId(r)),
    statusLabel(r.status),
    r.paths.length > 0 ? String(r.paths.length) : '-'
  ])
  await writeSummary('ArgoCD Diff', [
    `**${changed.length} ${plural} differ for ${appLink(app, client)}.**`,
    '',
    table(['Resource', 'Change', 'Changed fields'], rows)
  ])
}
