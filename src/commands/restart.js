import * as core from '@actions/core'
import { resourceId } from '../util.js'

/**
 * Run the "restart" resource action on every managed resource whose kind is in
 * `kinds` (e.g. Deployment, StatefulSet, DaemonSet). Mirrors
 * `argocd app actions run <app> restart --kind`.
 *
 * @returns {Promise<number>} the number of resources restarted.
 */
export async function restartResources(client, app, { kinds = ['Deployment'], action = 'restart', log = core.info } = {}) {
  const application = await client.getApp(app)
  const resources = (application.status?.resources || []).filter((r) => kinds.includes(r.kind))

  if (resources.length === 0) {
    log(`No ${kinds.join('/')} resources found for ${app} to ${action}.`)
    return 0
  }

  for (const r of resources) {
    await client.runResourceAction(app, {
      group: r.group || '',
      version: r.version || 'v1',
      kind: r.kind,
      namespace: r.namespace || '',
      resourceName: r.name,
      action
    })
    log(`${action} ${resourceId(r)}`)
  }
  return resources.length
}
