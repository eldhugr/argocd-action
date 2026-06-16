import * as core from '@actions/core'
import { appLink, code, fmtTime, imagesCell, shortRevision, table, writeSummary } from '../summary.js'

/**
 * Read-only status fetch. Mirrors `argocd app get`: it changes nothing and
 * just exposes the application's current state as outputs.
 */
export async function run(client, app) {
  const refresh = core.getInput('refresh')
  const application = await client.getApp(app, refresh ? { refresh } : {})

  const status = application.status || {}
  const syncStatus = status.sync?.status || 'Unknown'
  const healthStatus = status.health?.status || 'Unknown'
  const revision =
    status.sync?.revision || (status.sync?.revisions || []).join(',') || ''
  const images = status.summary?.images || []
  const history = status.history || []

  core.info(`${app}: sync=${syncStatus} health=${healthStatus} revision=${revision || '-'}`)
  for (const image of images) core.info(`  image: ${image}`)

  core.setOutput('sync-status', syncStatus)
  core.setOutput('health-status', healthStatus)
  core.setOutput('revision', revision)
  core.setOutput('images', JSON.stringify(images))
  core.setOutput('history', JSON.stringify(history))

  const lines = [
    `**${code(app)} is ${syncStatus} and ${healthStatus}.**`,
    '',
    table(
      ['Application', 'Sync', 'Health', 'Revision', 'Image'],
      [[appLink(app, client), syncStatus, healthStatus, code(shortRevision(revision)), imagesCell(images)]]
    )
  ]
  if (history.length > 0) {
    const last = [...history].sort((a, b) => Number(b.id) - Number(a.id))[0]
    const when = last?.deployedAt ? `; last deployed ${fmtTime(last.deployedAt)}` : ''
    lines.push('', `${history.length} deployment${history.length === 1 ? '' : 's'} in history${when}.`)
  }
  await writeSummary('ArgoCD Get', lines)
}
