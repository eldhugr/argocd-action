import * as core from '@actions/core'
import { parseBool, parseNumber } from '../config.js'
import { parseList } from '../util.js'
import { waitForApp } from './wait.js'
import { appLink, code, imagesCell, ok, table, writeSummary } from '../summary.js'

/**
 * Build an ArgoCD ApplicationSyncRequest body from the high-level options.
 * Mirrors the `argocd app sync` flags: --prune, --force, --replace,
 * --server-side, --apply-out-of-sync-only, --sync-option, --strategy,
 * --dry-run, --revision.
 */
export function buildSyncBody({
  prune = false,
  dryRun = false,
  force = false,
  replace = false,
  serverSide = false,
  applyOutOfSyncOnly = false,
  syncOptions = [],
  strategy = '',
  revision = '',
  resources = []
} = {}) {
  const body = {}
  if (prune) body.prune = true
  if (dryRun) body.dryRun = true
  if (revision) body.revision = revision
  if (resources.length > 0) body.resources = resources

  // Boolean conveniences map onto the same string sync options the CLI sends.
  // They are appended *after* the raw `syncOptions` so that, on a duplicate key,
  // the explicit flag wins (consolidateSyncOptions keeps the last value per key).
  const options = [...syncOptions]
  if (replace) options.push('Replace=true')
  if (serverSide) options.push('ServerSideApply=true')
  if (applyOutOfSyncOnly) options.push('ApplyOutOfSyncOnly=true')
  const consolidated = consolidateSyncOptions(options)
  warnUnknownSyncOptions(consolidated)
  if (consolidated.length > 0) body.syncOptions = { items: consolidated }

  // `force` and an explicit strategy both require a strategy block. ArgoCD
  // defaults to "apply"; "hook" runs the sync via resource hooks instead.
  if (force || strategy) {
    const kind = strategy === 'hook' ? 'hook' : 'apply'
    body.strategy = { [kind]: force ? { force: true } : {} }
  }
  return body
}

/**
 * Consolidate a `Name=value` sync-option list so the same option can't be sent
 * twice (e.g. `server-side: true` *and* `sync-options: ServerSideApply=true`).
 * Duplicate keys collapse to a single entry keeping the **last** value, so the
 * boolean flags - appended last by buildSyncBody - win over the same option
 * given as a raw string. Exact duplicates are dropped silently; a genuine value
 * conflict for one key is surfaced as a warning. Insertion order is preserved.
 */
export function consolidateSyncOptions(options) {
  const byKey = new Map()
  for (const opt of options) {
    const eq = opt.indexOf('=')
    const key = eq === -1 ? opt : opt.slice(0, eq)
    const prev = byKey.get(key)
    if (prev !== undefined && prev !== opt) {
      core.warning(`Conflicting sync option "${key}": "${prev}" overridden by "${opt}".`)
    }
    byKey.set(key, opt)
  }
  return [...byKey.values()]
}

/**
 * ArgoCD's recognised sync-option keys (the `Name` in a `Name=value` entry).
 * Used only to warn on a likely typo in the free-form `sync-options` input - the
 * keys the `replace`/`server-side`/`apply-out-of-sync-only` flags emit are
 * included so flag-derived options never trip the check.
 */
export const KNOWN_SYNC_OPTIONS = new Set([
  'Validate',
  'CreateNamespace',
  'PrunePropagationPolicy',
  'PruneLast',
  'ApplyOutOfSyncOnly',
  'RespectIgnoreDifferences',
  'ServerSideApply',
  'FailOnSharedResource',
  'Replace'
])

/**
 * Warn (don't fail) on sync-option keys ArgoCD doesn't recognise - this recovers
 * some type-safety for the free-form `sync-options` escape hatch by catching
 * typos like `ServerSideAply=true`. It only warns, since ArgoCD may add options
 * this list doesn't know yet.
 */
export function warnUnknownSyncOptions(options) {
  for (const opt of options) {
    const eq = opt.indexOf('=')
    const key = eq === -1 ? opt : opt.slice(0, eq)
    if (!KNOWN_SYNC_OPTIONS.has(key)) {
      core.warning(
        `Unknown sync option "${key}" - check for a typo. Known options: ${[...KNOWN_SYNC_OPTIONS].join(', ')}.`
      )
    }
  }
}

/**
 * Parse the `resources` input into ArgoCD SyncOperationResource entries that
 * scope a sync to specific resources. Each newline/comma item is
 * `[group:]kind:name` (mirrors `argocd app sync --resource`); the group is blank
 * for core resources, given as either `:Service:web` or just `Service:web`.
 */
export function parseResources(raw) {
  return parseList(raw).map((item) => {
    const parts = item.split(':').map((s) => s.trim())
    const spec =
      parts.length === 2
        ? { group: '', kind: parts[0], name: parts[1] }
        : parts.length === 3
          ? { group: parts[0], kind: parts[1], name: parts[2] }
          : null
    if (!spec || !spec.kind || !spec.name) {
      throw new Error(`Invalid resource "${item}" - expected [group:]kind:name (e.g. apps:Deployment:web or :Service:web)`)
    }
    return spec
  })
}

/** Read the sync options shared by the `sync` and `deploy` commands. */
export function readSyncOptions() {
  return {
    prune: parseBool(core.getInput('prune'), false),
    force: parseBool(core.getInput('force'), false),
    replace: parseBool(core.getInput('replace'), false),
    serverSide: parseBool(core.getInput('server-side'), false),
    applyOutOfSyncOnly: parseBool(core.getInput('apply-out-of-sync-only'), false),
    syncOptions: parseList(core.getInput('sync-options')),
    strategy: core.getInput('strategy').trim(),
    dryRun: parseBool(core.getInput('dry-run'), false),
    revision: core.getInput('revision').trim(),
    resources: parseResources(core.getInput('resources'))
  }
}

export async function run(client, app) {
  const body = buildSyncBody(readSyncOptions())
  core.info(`Syncing ${app}...`)
  await client.sync(app, body)

  // A dry-run never produces an operation to wait for.
  if (body.dryRun) {
    core.info(`Dry-run sync requested for ${app}; not waiting.`)
    await writeSummary('ArgoCD Sync', [
      `**Dry-run sync previewed for ${appLink(app, client)}; cluster unchanged.**`
    ])
    return
  }

  const status = await waitForApp(client, app, {
    timeoutSeconds: parseNumber(core.getInput('timeout'), 600),
    forSync: parseBool(core.getInput('wait-for-sync'), true),
    forHealth: parseBool(core.getInput('wait-for-health'), true),
    forOperation: parseBool(core.getInput('wait-for-operation'), true),
    refresh: 'normal'
  })
  core.setOutput('sync-status', status.syncStatus)
  core.setOutput('health-status', status.healthStatus)
  core.setOutput('revision', status.revision)

  await writeSummary('ArgoCD Sync', [
    `**${code(app)} synced.**`,
    '',
    table(
      ['Application', 'Result', 'Sync', 'Health', 'Details'],
      [[appLink(app, client), ok('Synced'), status.syncStatus, status.healthStatus, imagesCell(status.images)]]
    )
  ])
}
