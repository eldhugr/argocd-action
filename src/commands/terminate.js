import * as core from '@actions/core'

/**
 * Terminate the application's currently running sync operation.
 * Mirrors `argocd app terminate-op`.
 */
export async function run(client, app) {
  core.info(`Terminating the running operation for ${app}...`)
  await client.terminateOperation(app)
  core.info(`Termination requested for ${app}.`)
}
