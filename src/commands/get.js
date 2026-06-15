import * as core from '@actions/core'

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

  core.info(`${app}: sync=${syncStatus} health=${healthStatus} revision=${revision || '—'}`)
  for (const image of images) core.info(`  image: ${image}`)

  core.setOutput('sync-status', syncStatus)
  core.setOutput('health-status', healthStatus)
  core.setOutput('revision', revision)
  core.setOutput('images', JSON.stringify(images))
  core.setOutput('history', JSON.stringify(status.history || []))
}
