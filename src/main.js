import * as core from '@actions/core'
import { resolveConfig } from './config.js'
import { ArgoClient } from './client.js'
import { run as runSet } from './commands/set.js'
import { run as runDiff } from './commands/diff.js'
import { run as runWait } from './commands/wait.js'
import { run as runDeploy } from './commands/deploy.js'
import { run as runSync } from './commands/sync.js'
import { run as runGet } from './commands/get.js'
import { run as runRollback } from './commands/rollback.js'
import { run as runHistory } from './commands/history.js'
import { run as runTerminate } from './commands/terminate.js'

const COMMANDS = {
  set: runSet,
  diff: runDiff,
  wait: runWait,
  deploy: runDeploy,
  sync: runSync,
  get: runGet,
  rollback: runRollback,
  history: runHistory,
  'terminate-op': runTerminate
}

/** Build an authenticated ArgoCD client according to the resolved auth method. */
async function createClient(config) {
  if (config.authMethod === 'token') {
    return new ArgoClient(config)
  }
  if (config.authMethod === 'oidc') {
    core.info('Authenticating to ArgoCD via GitHub OIDC token exchange...')
    const idToken = await core.getIDToken(config.oidcAudience || undefined)
    return ArgoClient.loginOidc({ ...config, idToken })
  }
  return ArgoClient.login(config)
}

/**
 * The main function for the action.
 *
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run() {
  try {
    const command = core.getInput('command', { required: true }).trim()
    const application = core.getInput('application').trim()

    const handler = COMMANDS[command]
    if (!handler) {
      throw new Error(
        `Unknown command "${command}". Expected one of: ${Object.keys(COMMANDS).join(', ')}.`
      )
    }

    // `deploy` may take its application list from the `applications` input.
    if (command !== 'deploy' && !application) {
      throw new Error('Input required and not supplied: application')
    }

    const config = resolveConfig()
    const client = await createClient(config)

    core.info(`argocd app ${command}${application ? ` ${application}` : ''}`)
    await handler(client, application)
  } catch (error) {
    // Fail the workflow run if an error occurs
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
