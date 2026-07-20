import * as core from '@actions/core'
import { parseBool, parseNumber } from '../config.js'
import { setParameters, toParams } from './set.js'
import { computeDiff, logDiff } from './diff.js'
import { renderUnifiedDiff, imageChanges } from '../diff.js'
import { waitForApp } from './wait.js'
import { restartResources } from './restart.js'
import { buildSyncBody, readSyncOptions } from './sync.js'
import { appLink, code, escapeCell, fail, imagesCell, ok, shortImage, table, writeSummary } from '../summary.js'

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
    forOperation: parseBool(core.getInput('wait-for-operation'), true),
    failOnRolloutFailure: parseBool(core.getInput('fail-on-rollout-failure'), true)
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
    throw new Error('Provide `application` (single) or `applications` (multiple).')
  }
  return [app]
}

/**
 * Cap on how many applications deploy concurrently in parallel mode. A fixed
 * pool of workers drains the queue, so any number of apps can be passed without
 * opening an unbounded number of connections to the ArgoCD gateway at once.
 */
const MAX_PARALLEL = 8

/**
 * Run `worker` over `items` with at most `limit` in flight at once: a fixed pool
 * of `limit` workers drains a shared queue (`limit >= items.length` just runs
 * them all). Resolves to a Promise.allSettled-style array aligned to `items`, so
 * a single failure never rejects the whole batch.
 */
export async function settledWithConcurrency(items, limit, worker) {
  if (limit >= items.length) {
    return Promise.allSettled(items.map((item, i) => worker(item, i)))
  }
  const results = new Array(items.length)
  let next = 0
  const runner = async () => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, runner))
  return results
}

/** Run the set → diff → (restart|sync) → wait sequence for one application. */
async function deployOne(client, app, settings) {
  const log = (msg) => core.info(`[${app}] ${msg}`)
  const result = {
    app,
    status: 'unchanged',
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
  // When unified-diff is on, stash the rendered (Secret-masked) +/- block so the
  // step summary can show it per app. Kept off the `results` output (stripped in
  // run) to avoid bloating it.
  if (settings.unified && diff.hasDiff) {
    result.diffText = renderUnifiedDiff(diff.resources)
  }
  // Container-image transitions (old → new) drive the summary's Details cell, so
  // a successful row shows what changed rather than just the end-state image.
  if (diff.hasDiff) {
    result.imageChanges = imageChanges(diff.resources)
  }

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
    failOnRolloutFailure: settings.failOnRolloutFailure,
    refresh: result.action !== 'none' ? settings.refresh : undefined,
    log
  })
  result.syncStatus = status.syncStatus
  result.healthStatus = status.healthStatus
  result.revision = status.revision
  result.images = status.images
  result.status = statusForAction(result.action)
  return result
}

/** Map a successful deploy's action token to its canonical result status. */
function statusForAction(action) {
  if (action === 'sync') return 'updated'
  if (/^restart\(\d+\)$/.test(action)) return 'restarted'
  return 'unchanged'
}

/**
 * Classify a per-application failure into a result status from the HTTP status
 * of the underlying ArgoCD error: 404 -> `missing` (the app does not exist),
 * 403 -> `forbidden` (ArgoCD returns this both for a non-existent app and a
 * genuine RBAC denial - "missing or no access"), anything else -> `failed`.
 */
function statusForError(err) {
  if (err?.status === 404) return 'missing'
  if (err?.status === 403) return 'forbidden'
  return 'failed'
}

/**
 * Statuses downgraded from job-failure to a warning by `ignore-missing`: the
 * app does not exist (404 `missing`) or ArgoCD masked a missing app as a 403
 * (`forbidden`). `forbidden` is included because, without a `project`, ArgoCD
 * returns 403 for a non-existent app - so covering only 404 would not catch the
 * common case. The cost is that a genuine RBAC denial is tolerated too; the app
 * is still reported, only the job-failure is suppressed.
 */
const tolerated = (r) => r.status === 'missing' || r.status === 'forbidden'

/** The status buckets reported in the `summary` output, in display order. */
const SUMMARY_STATUSES = ['updated', 'restarted', 'unchanged', 'missing', 'forbidden', 'failed']

/** Group application names by their result status into the `summary` object. */
function summarize(results) {
  const summary = Object.fromEntries(SUMMARY_STATUSES.map((s) => [s, []]))
  for (const r of results) {
    ;(summary[r.status] || (summary[r.status] = [])).push(r.app)
  }
  return summary
}

export async function run(client, app) {
  const settings = readSettings()
  const apps = resolveAppNames(app, core.getInput('applications'))
  const parallel = parseBool(core.getInput('parallel'), true)
  const allowFailure = parseBool(core.getInput('allow-failure'), false)
  const ignoreMissing = parseBool(core.getInput('ignore-missing'), false)
  // allow-failure forces fail-fast off, so every app is attempted and reported.
  const failFast = allowFailure ? false : parseBool(core.getInput('fail-fast'), true)

  const capped = parallel && apps.length > MAX_PARALLEL
  core.info(
    `Deploying ${apps.length} application(s)${capped ? ` (max ${MAX_PARALLEL} at a time)` : ''}: ${apps.join(', ')}`
  )

  const toError = (name, err) => ({
    app: name,
    status: statusForError(err),
    error: err instanceof Error ? err.message : String(err)
  })

  let results
  if (parallel && apps.length > 1) {
    const settled = await settledWithConcurrency(apps, MAX_PARALLEL, (name) =>
      deployOne(client, name, settings)
    )
    results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value : toError(apps[i], s.reason)))
  } else {
    results = []
    for (const name of apps) {
      try {
        results.push(await deployOne(client, name, settings))
      } catch (err) {
        core.error(`[${name}] ${err instanceof Error ? err.message : err}`)
        const errored = toError(name, err)
        results.push(errored)
        // A tolerated (not-found) app under ignore-missing must not trip
        // fail-fast and abort the rest of the batch.
        if (failFast && !(ignoreMissing && tolerated(errored))) break
      }
    }
  }

  const failures = results.filter((r) => r.error)
  const succeeded = results.filter((r) => !r.error)
  const outcome = failures.length === 0 ? 'success' : succeeded.length === 0 ? 'failure' : 'partial'

  // `diffText`/`imageChanges` are summary-only; keep them out of the output so
  // its documented shape stays stable.
  core.setOutput('results', JSON.stringify(results.map(({ diffText, imageChanges: _i, ...r }) => r)))
  core.setOutput('outcome', outcome)
  // `summary` groups names by status so a downstream step can render "updated /
  // not found / forbidden / failed" without reparsing `results`. The names that
  // did not deploy are the union of its missing/forbidden/failed buckets.
  core.setOutput('summary', JSON.stringify(summarize(results)))
  // Convenience scalar outputs when deploying exactly one application.
  if (results.length === 1 && !results[0].error) {
    const r = results[0]
    core.setOutput('diff', String(r.diff))
    core.setOutput('sync-status', r.syncStatus)
    core.setOutput('health-status', r.healthStatus)
    core.setOutput('revision', r.revision)
  }

  await reportStatus(client, results, outcome)

  // ignore-missing downgrades not-found / 403 apps to a warning; allow-failure
  // (if set) tolerates every failure. Whatever remains is a hard failure that
  // fails the job.
  const ignored = ignoreMissing ? failures.filter(tolerated) : []
  const blocking = failures.filter((f) => !ignored.includes(f))

  if (ignored.length > 0) {
    core.warning(
      `${ignored.length}/${apps.length} application(s) not found and ignored (ignore-missing): ` +
        ignored.map((f) => f.app).join(', ')
    )
  }
  if (blocking.length > 0 && !allowFailure) {
    throw new Error(
      `Deploy failed for ${blocking.length}/${apps.length} application(s): ` +
        blocking.map((f) => `${f.app}: ${f.error}`).join('; ')
    )
  }
  if (blocking.length > 0) {
    core.warning(
      `${blocking.length}/${apps.length} application(s) failed, but allow-failure is set - not failing the job.`
    )
  }
}

/** Map a successful deploy's action token to a single "what happened" label. */
function resultLabel(action) {
  if (action === 'sync') return ok('Deployed')
  if (/^restart\(\d+\)$/.test(action)) return ok('Restarted')
  return ok('No change')
}

/** The Result-column label for a failed application, by its result status. */
function errorLabel(status) {
  if (status === 'missing') return fail('Not found')
  if (status === 'forbidden') return fail('Forbidden')
  return fail('Failed')
}

/**
 * The Details cell for a successful deploy: the image transition (`old → new`,
 * shortened to `basename:tag`) when a container image changed, otherwise the
 * running image(s). Multiple changes stack with a line break.
 */
function detailsCell(r) {
  if (r.imageChanges && r.imageChanges.length > 0) {
    return r.imageChanges
      .map(({ before, after }) => `${code(shortImage(before))} → ${code(shortImage(after))}`)
      .join('<br>')
  }
  return imagesCell(r.images)
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
      ? [appLink(r.app, client), errorLabel(r.status), '', '', escapeCell(r.error)]
      : [
          appLink(r.app, client),
          resultLabel(r.action),
          r.syncStatus || 'Unknown',
          r.healthStatus || 'Unknown',
          detailsCell(r)
        ]
  )
  const lines = [
    headline,
    '',
    table(['Application', 'Result', 'Sync', 'Health', 'Details'], rows)
  ]
  // Per-application unified diff (when unified-diff is set), shown expanded under
  // a per-app heading. Secret values are already masked in the rendered text.
  // Apps without a rendered diff add nothing.
  for (const r of results) {
    if (r.diffText) {
      lines.push('', `**Diff for ${code(r.app)}**`, '', '```diff', r.diffText, '```')
    }
  }
  await writeSummary('ArgoCD Deploy', lines)
}
