import * as core from '@actions/core'
import { parseBool, parseNumber } from '../config.js'
import { parseList } from '../util.js'
import { waitForApp } from './wait.js'

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
  revision = ''
} = {}) {
  const body = {}
  if (prune) body.prune = true
  if (dryRun) body.dryRun = true
  if (revision) body.revision = revision

  // Boolean conveniences map onto the same string sync options the CLI sends.
  const options = [...syncOptions]
  if (replace) options.push('Replace=true')
  if (serverSide) options.push('ServerSideApply=true')
  if (applyOutOfSyncOnly) options.push('ApplyOutOfSyncOnly=true')
  if (options.length > 0) body.syncOptions = { items: options }

  // `force` and an explicit strategy both require a strategy block. ArgoCD
  // defaults to "apply"; "hook" runs the sync via resource hooks instead.
  if (force || strategy) {
    const kind = strategy === 'hook' ? 'hook' : 'apply'
    body.strategy = { [kind]: force ? { force: true } : {} }
  }
  return body
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
    revision: core.getInput('revision').trim()
  }
}

export async function run(client, app) {
  const body = buildSyncBody(readSyncOptions())
  core.info(`Syncing ${app}...`)
  await client.sync(app, body)

  // A dry-run never produces an operation to wait for.
  if (body.dryRun) {
    core.info(`Dry-run sync requested for ${app}; not waiting.`)
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
}
