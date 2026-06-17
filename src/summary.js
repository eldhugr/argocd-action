import * as core from '@actions/core'

/**
 * Shared helpers for the per-command GitHub step-summary blocks. Every command
 * renders through {@link writeSummary} so that, when a job runs several action
 * steps, each block is self-contained and visually separated by a rule.
 */

/** One Markdown table cell: strip pipes/newlines and cap the length. */
export function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').slice(0, 300)
}

/** Wrap a value in an escaped, monospace code span (empty stays empty). */
export function code(value) {
  const v = escapeCell(value)
  return v ? `\`${v}\`` : ''
}

/** A ✓-prefixed success label for the Result column. */
export const ok = (text) => `✓ ${text}`

/** A ✗-prefixed failure label for the Result column. */
export const fail = (text) => `✗ ${text}`

/**
 * Application name as a monospace label, linked to its ArgoCD UI page when the
 * client knows the server. The namespace defaults to `argocd`.
 */
export function appLink(app, client) {
  const label = code(app)
  const baseUrl = client?.baseUrl || ''
  if (!baseUrl) return label
  const ns = encodeURIComponent(client?.appNamespace || 'argocd')
  return `[${label}](${baseUrl}/applications/${ns}/${encodeURIComponent(app)})`
}

/**
 * Shorten a full image reference to `basename:tag` (or `basename@sha256:1234567`
 * for digests), dropping the registry/namespace prefix. A registry port colon
 * (e.g. `registry:5000/...`) is not mistaken for the tag separator.
 */
export function shortImage(ref) {
  const s = String(ref || '').trim()
  if (!s) return ''
  const at = s.indexOf('@')
  let name = s
  let suffix = ''
  if (at !== -1) {
    name = s.slice(0, at)
    const m = /^([a-z0-9]+):([0-9a-f]+)$/i.exec(s.slice(at + 1))
    suffix = m ? `@${m[1]}:${m[2].slice(0, 7)}` : `@${s.slice(at + 1)}`
  } else {
    const lastColon = s.lastIndexOf(':')
    if (lastColon > s.lastIndexOf('/')) {
      name = s.slice(0, lastColon)
      suffix = `:${s.slice(lastColon + 1)}`
    }
  }
  return name.slice(name.lastIndexOf('/') + 1) + suffix
}

/**
 * The container image(s) reported running, shortened to `basename:tag`. Shows
 * the first image plus a `(+N)` count when several run; '' when none are known.
 */
export function imagesCell(images) {
  const list = (images || []).map(shortImage).filter(Boolean)
  if (list.length === 0) return ''
  const extra = list.length > 1 ? ` (+${list.length - 1})` : ''
  return `${code(list[0])}${extra}`
}

/** Placeholder shown in place of a masked secret value. */
export const MASK = '***'

/**
 * Heuristic: does this parameter name look like it holds a secret? Matches common
 * substrings (password, token, secret, credential, auth, ...) and any name ending
 * in "key" (`tls.key`, `apiKey`, ...). Separators and case are ignored, so
 * `api-key`, `api_key` and `apiKey` all match. Errs toward masking; used to
 * redact values in step summaries and logs.
 */
export function isSecretName(name) {
  const n = String(name || '').toLowerCase().replace(/[-_.]/g, '')
  return /pass|pwd|secret|token|credential|auth|signature|apikey|accesskey|privatekey/.test(n) || /key$/.test(n)
}

/** The first revision, shortened to a 7-char sha when it looks like one. */
export function shortRevision(revision) {
  const first = String(revision || '').split(',')[0].trim()
  if (!first) return ''
  return /^[0-9a-f]{8,}$/i.test(first) ? first.slice(0, 7) : first
}

/** Format an RFC3339 timestamp as `YYYY-MM-DD HH:MM[ UTC]`; passthrough on miss. */
export function fmtTime(iso) {
  const s = String(iso || '').trim()
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(Z)?/.exec(s)
  return m ? `${m[1]} ${m[2]}${m[3] ? ' UTC' : ''}` : s
}

/** Build a left-aligned Markdown table from headers and an array of row arrays. */
export function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => ':--').join(' | ')} |`,
    ...rows.map((cells) => `| ${cells.join(' | ')} |`)
  ].join('\n')
}

/**
 * Append a self-contained summary block to the GitHub step summary, followed by
 * a horizontal rule so several action steps in one job stay visually separated.
 * Best-effort: never throws (the step summary is unavailable when run locally).
 *
 * @param {string} title  section heading, e.g. "ArgoCD Deploy"
 * @param {string[]} lines body lines (headline, tables, notes)
 */
export async function writeSummary(title, lines) {
  try {
    core.summary.addRaw(`### ${title}\n\n${lines.join('\n')}\n`, true).addSeparator()
    await core.summary.write()
  } catch {
    // Step summary is best-effort (e.g. unavailable when run locally).
  }
}
