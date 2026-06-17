/**
 * Structural JSON diff used to reproduce `argocd app diff`'s diff / no-diff
 * decision. We compare the server-computed `normalizedLiveState` (live, with
 * ignoreDifferences and normalizers already applied) against the
 * `predictedLiveState` (target). This mirrors what the CLI renders, without
 * reimplementing ArgoCD's normalization engine - that work happens server-side.
 */

import { resourceId } from './util.js'

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Walk two JSON values and collect the paths that differ. Returns an array of
 * { path, type } where type is 'added' | 'removed' | 'changed'.
 */
export function deepDiff(live, target, path = '', acc = []) {
  if (live === target) return acc

  if (Array.isArray(live) && Array.isArray(target)) {
    const max = Math.max(live.length, target.length)
    for (let i = 0; i < max; i++) {
      const p = `${path}[${i}]`
      if (i >= live.length) acc.push({ path: p, type: 'added', after: target[i] })
      else if (i >= target.length) acc.push({ path: p, type: 'removed', before: live[i] })
      else deepDiff(live[i], target[i], p, acc)
    }
    return acc
  }

  if (isObject(live) && isObject(target)) {
    const keys = new Set([...Object.keys(live), ...Object.keys(target)])
    for (const key of keys) {
      const p = path ? `${path}.${key}` : key
      const inLive = Object.prototype.hasOwnProperty.call(live, key)
      const inTarget = Object.prototype.hasOwnProperty.call(target, key)
      if (!inLive) acc.push({ path: p, type: 'added', after: target[key] })
      else if (!inTarget) acc.push({ path: p, type: 'removed', before: live[key] })
      else deepDiff(live[key], target[key], p, acc)
    }
    return acc
  }

  // Primitives (or type mismatch) that aren't strictly equal.
  acc.push({ path: path || '(root)', type: 'changed', before: live, after: target })
  return acc
}

function parseState(state) {
  if (state === undefined || state === null || state === '') return null
  if (typeof state === 'object') return state
  try {
    return JSON.parse(state)
  } catch {
    return null
  }
}

/**
 * Compare a single managed-resource entry from the managed-resources response.
 * Returns { changed, kind, name, namespace, status, paths }.
 *
 *   status: 'added'    -> exists in target only (will be created)
 *           'pruned'   -> exists live only (will be deleted)
 *           'modified' -> exists in both but differs
 *           'same'     -> no difference
 */
export function diffResource(item) {
  const live = parseState(item.normalizedLiveState ?? item.liveState)
  const target = parseState(item.predictedLiveState ?? item.targetState)

  const meta = {
    group: item.group || '',
    kind: item.kind || '',
    name: item.name || '',
    namespace: item.namespace || ''
  }

  if (live === null && target !== null) {
    return { ...meta, changed: true, status: 'added', paths: [] }
  }
  if (live !== null && target === null) {
    return { ...meta, changed: true, status: 'pruned', paths: [] }
  }
  if (live === null && target === null) {
    return { ...meta, changed: false, status: 'same', paths: [] }
  }

  const paths = deepDiff(live, target)
  return {
    ...meta,
    changed: paths.length > 0,
    status: paths.length > 0 ? 'modified' : 'same',
    paths
  }
}

/**
 * Diff every item in a managed-resources response.
 * Returns { hasDiff, resources: [diffResource(...)] }.
 */
export function diffManagedResources(items = []) {
  const resources = items.map(diffResource)
  return { hasDiff: resources.some((r) => r.changed), resources }
}

// --- Unified (pretty) diff rendering ---------------------------------------

/** Max field changes rendered per resource before the rest are summarised. */
const DEFAULT_MAX_FIELDS = 50
/** Cap a single rendered value so one long field can't dominate the block. */
const VALUE_CAP = 160
/** Placeholder for a masked Secret value (kept local to keep this module pure). */
const SECRET_MASK = '***'

/** Render a JSON value as a single-line string for a diff line. */
function formatValue(v) {
  if (v === undefined) return ''
  if (v === null) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Collapse newlines/runs of whitespace and cap the length of a value cell. */
function oneLine(value, cap = VALUE_CAP) {
  const s = String(value).replace(/\s*\n\s*/g, ' ')
  return s.length > cap ? `${s.slice(0, cap)}...` : s
}

/**
 * Format one field value for a diff line. The values of `Secret` resources are
 * masked so they never reach the step summary, a PR comment, or the job log.
 * Shared by the unified summary renderer and the `diff` command's job log.
 */
export function renderFieldValue(value, { secret = false } = {}) {
  return secret ? SECRET_MASK : oneLine(formatValue(value))
}

/**
 * Render one resource's changes as unified-diff lines (`-` old / `+` new),
 * headed by a `@@ Kind/namespace/name @@` hunk line. `Secret` values are masked
 * so they never leak into the summary or a PR comment. Returns an array of lines.
 */
function renderResourceDiff(r, { maxFields = DEFAULT_MAX_FIELDS } = {}) {
  const id = resourceId(r)
  if (r.status === 'added') return [`@@ ${id} (added) @@`, '+ (resource created)']
  if (r.status === 'pruned') return [`@@ ${id} (pruned) @@`, '- (resource deleted)']

  const secret = r.kind === 'Secret'
  const value = (x) => renderFieldValue(x, { secret })
  const lines = [`@@ ${id} @@`]
  for (const p of r.paths.slice(0, maxFields)) {
    if (p.type === 'added') {
      lines.push(`+ ${p.path}: ${value(p.after)}`)
    } else if (p.type === 'removed') {
      lines.push(`- ${p.path}: ${value(p.before)}`)
    } else {
      lines.push(`- ${p.path}: ${value(p.before)}`)
      lines.push(`+ ${p.path}: ${value(p.after)}`)
    }
  }
  if (r.paths.length > maxFields) {
    lines.push(`  ... and ${r.paths.length - maxFields} more field(s)`)
  }
  return lines
}

/**
 * Render the changed resources of a computeDiff() result as a single unified
 * diff string (no code fence). Suitable for a ```diff block in the step summary
 * or a PR comment. Unchanged resources are skipped; '' when nothing changed.
 */
export function renderUnifiedDiff(resources = [], { maxFields = DEFAULT_MAX_FIELDS } = {}) {
  return resources
    .filter((r) => r.changed)
    .map((r) => renderResourceDiff(r, { maxFields }).join('\n'))
    .join('\n')
}
