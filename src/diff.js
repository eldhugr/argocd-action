/**
 * Structural JSON diff used to reproduce `argocd app diff`'s diff / no-diff
 * decision. We compare the server-computed `normalizedLiveState` (live, with
 * ignoreDifferences and normalizers already applied) against the
 * `predictedLiveState` (target). This mirrors what the CLI renders, without
 * reimplementing ArgoCD's normalization engine — that work happens server-side.
 */

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
      if (i >= live.length) acc.push({ path: p, type: 'added' })
      else if (i >= target.length) acc.push({ path: p, type: 'removed' })
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
      if (!inLive) acc.push({ path: p, type: 'added' })
      else if (!inTarget) acc.push({ path: p, type: 'removed' })
      else deepDiff(live[key], target[key], p, acc)
    }
    return acc
  }

  // Primitives (or type mismatch) that aren't strictly equal.
  acc.push({ path: path || '(root)', type: 'changed' })
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
