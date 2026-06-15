import * as core from '@actions/core'

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
      core.info(`  id=${h.id} revision=${h.revision || '—'}${h.deployedAt ? ` deployedAt=${h.deployedAt}` : ''}`)
    }
  }

  core.setOutput('history', JSON.stringify(history))
}
