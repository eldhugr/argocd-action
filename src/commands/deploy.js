import * as core from '@actions/core'
import { parseBool, parseNumber } from '../config.js'
import { setParameters, toParams } from './set.js'
import { computeDiff, logDiff } from './diff.js'
import { waitForApp } from './wait.js'
import { restartResources } from './restart.js'
import { buildSyncBody, readSyncOptions } from './sync.js'
import { appLink, escapeCell, fail, imagesCell, ok, table, writeSummary } from '../summary.js'

/**
 * The `deploy` umbrella command. For each application it performs the same
 * sequence the deploy-application workflow used to run as shell:
 *
 *   argocd app set <app> --parameter ...
 *   argocd app diff <app> --refresh && argocd app actions run <app> restart \
 *     --kind Deployment || argocd app sync <app>
 *   argocd app wait <app> --timeout <t>
 *
 * i.e. set params, refresh+diff, then **no rendered diff → restart** /
 * **rendered diff → sync**, then wait for the result.
 *
 * Targets are either a single `app` or a list of `applications`; every target
 * is deployed with the same settings (parameters, timeout, refresh, …).
 */

/**
 * Parse the `restart` input into the list of workload kinds to restart on a
 * no-diff deploy. `false`/empty → [] (disabled), otherwise a comma-separated
 * list of explicit kinds (e.g. "Deployment" or "Deployment,StatefulSet").
 */
export function parseRestartKinds(value) {
  const v = (value || '').trim()
  if (!v || /^(false|0|no|off)$/i.test(v)) return []
  return v
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
}

/** Read the settings applied to every target application. */
function readSettings() {
  return {
    parameters: core.getInput('parameters'),
    sourceName: core.getInput('source-name'),
    sourcePosition: core.getInput('source-position'),
    refresh: core.getInput('refresh') || 'normal',
    timeout: parseNumber(core.getInput('timeout'), 600),
    syncBody: buildSyncBody(readSyncOptions()),
    restartKinds: parseRestartKinds(core.getInput('restart')),
    unified: parseBool(core.getInput('unified-diff'), false),
    forSync: parseBool(core.getInput('wait-for-sync'), true),
    forHealth: parseBool(core.getInput('wait-for-health'), true),
    forOperation: parseBool(core.getInput('wait-for-operation'), true)
  }
}

/**
 * Resolve the list of application names from either `applications` (a JSON
 * array of names, or a newline/comma-separated list) or the single `app` input.
 */
export function resolveAppNames(app, applicationsRaw) {
  const raw = (applicationsRaw || '').trim()
  if (raw) {
    let names
    if (raw.startsWith('[')) {
      try {
        names = JSON.parse(raw)
      } catch (err) {
        throw new Error(`Invalid \`applications\` JSON: ${err.message}`)
      }
      if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
        throw new Error('`applications` JSON must be an array of strings.')
      }
    } else {
      names = raw.split(/[\n,]/)
    }
    names = names.map((n) => n.trim()).filter(Boolean)
    if (names.length === 0) {
      throw new Error('`applications` did not contain any application names.')
    }
    return names
  }
  if (!app) {
    throw new Error('Provide `app` (single) or `applications` (multiple).')
  }
  return [app]
}

/** Run the set → diff → (restart|sync) → wait sequence for one application. */
async function deployOne(client, app, settings) {
  const log = (msg) => core.info(`[${app}] ${msg}`)
  const result = {
    app,
    diff: false,
    action: 'none',
    syncStatus: '',
    healthStatus: '',
    revision: '',
    images: []
  }

  // 1. Update Helm parameters (skipped when none provided).
  const params = toParams(settings.parameters)
  if (params.length > 0) {
    await setParameters(client, app, {
      parameters: params,
      sourceName: settings.sourceName,
      sourcePosition: settings.sourcePosition,
      log
    })
  }

  // 2. Refresh + diff.
  const diff = await computeDiff(client, app, { refresh: settings.refresh, log })
  logDiff(app, diff, { log, unified: settings.unified })
  result.diff = diff.hasDiff

  // 3. Rendered diff → sync. No diff → restart the chosen workloads (if any),
  //    otherwise nothing: the app is already in its desired state.
  if (diff.hasDiff) {
    log(`Syncing ${app}...`)
    await client.sync(app, settings.syncBody)
    result.action = 'sync'
  } else if (settings.restartKinds.length > 0) {
    const n = await restartResources(client, app, { kinds: settings.restartKinds, log })
    result.action = `restart(${n})`
  } else {
    log(`No diff for ${app} - nothing to do.`)
    result.action = 'none'
  }

  // 4. Wait for the resulting operation to settle. When we just triggered a
  //    sync/restart, force a refresh on the first poll so we observe the new
  //    operation rather than a cached pre-sync Synced/Healthy state.
  const status = await waitForApp(client, app, {
    timeoutSeconds: settings.timeout,
    forSync: settings.forSync,
    forHealth: settings.forHealth,
    forOperation: settings.forOperation,
    refresh: result.action !== 'none' ? settings.refresh : undefined,
    log
  })
  result.syncStatus = status.syncStatus
  result.healthStatus = status.healthStatus
  result.revision = status.revision
  result.images = status.images
  return result
}

export async function run(client, app) {
  const settings = readSettings()
  const apps = resolveAppNames(app, core.getInput('applications'))
  const parallel = parseBool(core.getInput('parallel'), true)
  const allowFailure = parseBool(core.getInput('allow-failure'), false)
  // allow-failure forces fail-fast off, so every app is attempted and reported.
  const failFast = allowFailure ? false : parseBool(core.getInput('fail-fast'), true)

  core.info(`Deploying ${apps.length} application(s): ${apps.join(', ')}`)

  const toError = (name, err) => ({
    app: name,
    error: err instanceof Error ? err.message : String(err)
  })

  let results
  if (parallel && apps.length > 1) {
    const settled = await Promise.allSettled(apps.map((name) => deployOne(client, name, settings)))
    results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : toError(apps[i], s.reason)))
  } else {
    results = []
    for (const name of apps) {
      try {
        results.push(await deployOne(client, name, settings))
      } catch (err) {
        core.error(`[${name}] ${err instanceof Error ? err.message : err}`)
        results.push(toError(name, err))
        if (failFast) break
      }
    }
  }

  const failures = results.filter((r) => r.error)
  const succeeded = results.filter((r) => !r.error)
  const outcome = failures.length === 0 ? 'success' : succeeded.length === 0 ? 'failure' : 'partial'

  core.setOutput('results', JSON.stringify(results))
  core.setOutput('outcome', outcome)
  core.setOutput('failed', JSON.stringify(failures.map((f) => f.app)))
  // Convenience scalar outputs when deploying exactly one application.
  if (results.length === 1 && !results[0].error) {
    const r = results[0]
    core.setOutput('diff', String(r.diff))
    core.setOutput('sync-status', r.syncStatus)
    core.setOutput('health-status', r.healthStatus)
    core.setOutput('revision', r.revision)
  }

  await reportStatus(client, results, outcome)

  if (failures.length > 0 && !allowFailure) {
    throw new Error(
      `Deploy failed for ${failures.length}/${apps.length} application(s): ` +
        failures.map((f) => `${f.app}: ${f.error}`).join('; ')
    )
  }
  if (failures.length > 0) {
    core.warning(
      `${failures.length}/${apps.length} application(s) failed, but allow-failure is set - not failing the job.`
    )
  }
}

/** Map a successful deploy's action token to a single "what happened" label. */
function resultLabel(action) {
  if (action === 'sync') return ok('Deployed')
  if (/^restart\(\d+\)$/.test(action)) return ok('Restarted')
  return ok('No change')
}

/** Log a per-application summary and write a table to the GitHub step summary. */
async function reportStatus(client, results, outcome) {
  const succeeded = results.filter((r) => !r.error)
  const failed = results.filter((r) => r.error)
  const total = results.length

  core.info(`Deploy ${outcome}: ${succeeded.length} succeeded, ${failed.length} failed.`)
  for (const r of results) {
    if (r.error) core.info(`  ✗ ${r.app}: ${r.error}`)
    else core.info(`  ✓ ${r.app} (${r.action}) sync=${r.syncStatus} health=${r.healthStatus}`)
  }

  const plural = (n) => (n === 1 ? 'application' : 'applications')
  const headline =
    outcome === 'success'
      ? `**${succeeded.length} ${plural(succeeded.length)} deployed.**`
      : outcome === 'failure'
        ? `**${failed.length} ${plural(failed.length)} failed.**`
        : `**${succeeded.length} of ${total} deployed**, ${failed.length} failed.`

  const rows = results.map((r) =>
    r.error
      ? [appLink(r.app, client), fail('Failed'), '', '', escapeCell(r.error)]
      : [
          appLink(r.app, client),
          resultLabel(r.action),
          r.syncStatus || 'Unknown',
          r.healthStatus || 'Unknown',
          imagesCell(r.images)
        ]
  )
  await writeSummary('ArgoCD Deploy', [
    headline,
    '',
    table(['Application', 'Result', 'Sync', 'Health', 'Details'], rows)
  ])
}
