/** Resolve after `ms` milliseconds. Shared by the polling loops. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Render a managed/status resource as `Kind/namespace/name` (namespace omitted
 * for cluster-scoped resources). Shared by the diff and restart log output.
 */
export function resourceId(r) {
  return `${r.kind}/${r.namespace ? `${r.namespace}/` : ''}${r.name}`
}

/**
 * Split a newline/comma-separated input into a trimmed, non-empty list,
 * dropping `#` comment lines. Used for sync-options and similar list inputs.
 */
export function parseList(raw) {
  if (!raw) return []
  return String(raw)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
}
