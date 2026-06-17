import * as core from '@actions/core'
import { parseList } from '../util.js'
import { appLink, code, isSecretName, MASK, table, writeSummary } from '../summary.js'

/** Parse newline-separated `name=value` pairs into [{name, value}]. */
export function parseParameters(raw) {
  if (!raw) return []
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('=')
      if (idx === -1) {
        throw new Error(`Invalid parameter "${line}" - expected name=value`)
      }
      return { name: line.slice(0, idx).trim(), value: line.slice(idx + 1) }
    })
}

/**
 * Pick the source to mutate. Single-source apps use `spec.source`; multi-source
 * apps require a source-name or 1-based source-position.
 */
function selectSource(spec, { sourceName, sourcePosition }) {
  if (Array.isArray(spec.sources) && spec.sources.length > 0) {
    if (sourceName) {
      const match = spec.sources.find((s) => s.name === sourceName)
      if (!match) throw new Error(`No source named "${sourceName}" in application`)
      return match
    }
    if (sourcePosition) {
      const pos = Number(sourcePosition)
      if (!Number.isInteger(pos) || pos < 1 || pos > spec.sources.length) {
        throw new Error(
          `source-position ${sourcePosition} out of range (1..${spec.sources.length})`
        )
      }
      return spec.sources[pos - 1]
    }
    if (spec.sources.length === 1) return spec.sources[0]
    throw new Error(
      'Application has multiple sources - set `source-name` or `source-position`.'
    )
  }
  if (!spec.source) {
    spec.source = {}
  }
  return spec.source
}

/** Upsert helm parameters into a source, replacing existing entries by name. */
export function applyHelmParameters(source, params) {
  if (!source.helm) source.helm = {}
  if (!Array.isArray(source.helm.parameters)) source.helm.parameters = []
  const existing = source.helm.parameters
  for (const { name, value } of params) {
    const found = existing.find((p) => p.name === name)
    if (found) found.value = value
    else existing.push({ name, value })
  }
  return source
}

/** Remove helm parameters from a source by name. No-op when none are present. */
export function removeHelmParameters(source, names) {
  if (!names || names.length === 0) return source
  if (!source.helm || !Array.isArray(source.helm.parameters)) return source
  const remove = new Set(names)
  source.helm.parameters = source.helm.parameters.filter((p) => !remove.has(p.name))
  return source
}

/**
 * Normalize the `parameters` input, which may be a newline-separated string, an
 * array of `name=value` strings, or an array of `{ name, value }` objects.
 */
export function toParams(parameters) {
  if (!parameters) return []
  if (Array.isArray(parameters)) {
    return parameters.flatMap((p) => (typeof p === 'string' ? parseParameters(p) : [p]))
  }
  return parseParameters(parameters)
}

/**
 * Apply Helm parameters to an application's source and persist the spec.
 * Reusable op shared by the `set` and `deploy` commands.
 */
export async function setParameters(client, app, { parameters, unsetParameters, sourceName, sourcePosition, log = core.info } = {}) {
  const params = toParams(parameters)
  const unset = parseList(unsetParameters)
  if (params.length === 0 && unset.length === 0) {
    throw new Error('command "set" requires at least one parameter to set (`parameters`) or unset (`unset-parameters`).')
  }

  const application = await client.getApp(app)
  const spec = application.spec
  const source = selectSource(spec, { sourceName, sourcePosition })

  applyHelmParameters(source, params)
  removeHelmParameters(source, unset)

  for (const { name, value } of params) {
    // Secret-looking values are registered so GitHub redacts them everywhere in
    // the logs, and shown masked here too.
    const secret = isSecretName(name)
    if (secret && value) core.setSecret(value)
    log(`set ${name}=${secret ? MASK : value}`)
  }
  for (const name of unset) {
    log(`unset ${name}`)
  }

  await client.updateSpec(app, spec)
  log(`Updated spec for ${app}`)
}

/** Headline like "Set 2 parameters and unset 1 parameter on <app>." */
function changeHeadline(setCount, unsetCount, link) {
  const noun = (n) => `${n} parameter${n === 1 ? '' : 's'}`
  const parts = []
  if (setCount) parts.push(`Set ${noun(setCount)}`)
  if (unsetCount) parts.push(`${parts.length ? 'unset' : 'Unset'} ${noun(unsetCount)}`)
  return `**${parts.join(' and ')} on ${link}.**`
}

export async function run(client, app) {
  const parameters = core.getInput('parameters')
  const unsetParameters = core.getInput('unset-parameters')
  await setParameters(client, app, {
    parameters,
    unsetParameters,
    sourceName: core.getInput('source-name'),
    sourcePosition: core.getInput('source-position')
  })

  const params = toParams(parameters)
  const unset = parseList(unsetParameters)
  const rows = [
    ...params.map((p) => [code(p.name), code(isSecretName(p.name) ? MASK : p.value)]),
    ...unset.map((name) => [code(name), 'removed'])
  ]
  await writeSummary('ArgoCD Set', [
    changeHeadline(params.length, unset.length, appLink(app, client)),
    '',
    table(['Parameter', 'Value'], rows)
  ])
}
