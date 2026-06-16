import * as core from '@actions/core'
import { appLink, code, fmtTime, shortRevision, table, writeSummary } from '../summary.js'

/** At most this many history rows are rendered in the step summary. */
const SUMMARY_ROWS = 10

/**
 * List an application's deployment history. Mirrors `argocd app history`.
 * Sets the `history` output to the raw JSON array (newest last, as stored).
 */
export async function run(client, app) {
  const application = await client.getApp(app)
  const history = application.status?.history || []

  if (history.length === 0) {
    core.info(`No deployment history for ${app}.`)
  } else {
    core.info(`Deployment history for ${app}:`)
    for (const h of history) {
      core.info(`  id=${h.id} revision=${h.revision || '-'}${h.deployedAt ? ` deployedAt=${h.deployedAt}` : ''}`)
    }
  }

  core.setOutput('history', JSON.stringify(history))

  if (history.length === 0) {
    await writeSummary('ArgoCD History', [`**No deployment history for ${appLink(app, client)}.**`])
    return
  }
  const newestFirst = [...history].sort((a, b) => Number(b.id) - Number(a.id))
  const shown = newestFirst.slice(0, SUMMARY_ROWS)
  const rows = shown.map((h) => [String(h.id), code(shortRevision(h.revision)), fmtTime(h.deployedAt)])
  const lines = [
    `**${history.length} deployment${history.length === 1 ? '' : 's'} for ${appLink(app, client)}.**`,
    '',
    table(['ID', 'Revision', 'Deployed at'], rows)
  ]
  if (history.length > SUMMARY_ROWS) {
    lines.push('', `_Showing the ${SUMMARY_ROWS} most recent of ${history.length}._`)
  }
  await writeSummary('ArgoCD History', lines)
}
