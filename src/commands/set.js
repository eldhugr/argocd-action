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
  if (!params || params.length === 0) return source
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
 * The delimiter ArgoCD uses to split a kustomize image override into its
 * matchable name: the first of `=`, `:`, `@` present (else `:`). Mirrors
 * `KustomizeImage.delim()`.
 */
function kustomizeImageDelim(image) {
  for (const d of ['=', ':', '@']) {
    if (image.includes(d)) return d
  }
  return ':'
}

/**
 * Whether an existing kustomize image override targets the same image as an
 * incoming one. Mirrors `KustomizeImage.Match`: cut both at the *incoming*
 * override's delimiter and compare the name part.
 */
function kustomizeImageMatch(existing, incoming) {
  const delim = kustomizeImageDelim(incoming)
  const name = (s) => {
    const i = s.indexOf(delim)
    return i === -1 ? s : s.slice(0, i)
  }
  return name(existing) === name(incoming)
}

/**
 * Upsert kustomize image overrides into a source, replacing an existing override
 * for the same image by match (else appending). Mirrors ArgoCD's
 * `ApplicationSourceKustomize.MergeImage`. No-op when none are given.
 */
export function applyKustomizeImages(source, images) {
  if (!images || images.length === 0) return source
  if (!source.kustomize) source.kustomize = {}
  if (!Array.isArray(source.kustomize.images)) source.kustomize.images = []
  const existing = source.kustomize.images
  for (const image of images) {
    const idx = existing.findIndex((e) => kustomizeImageMatch(e, image))
    if (idx !== -1) existing[idx] = image
    else existing.push(image)
  }
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
export async function setParameters(client, app, { parameters, unsetParameters, kustomizeImages, sourceName, sourcePosition, log = core.info } = {}) {
  const params = toParams(parameters)
  const unset = parseList(unsetParameters)
  const images = parseList(kustomizeImages)
  if (params.length === 0 && unset.length === 0 && images.length === 0) {
    throw new Error(
      'command "set" requires at least one parameter to set (`parameters`), unset (`unset-parameters`), or a kustomize image (`kustomize-images`).'
    )
  }

  const application = await client.getApp(app)
  const spec = application.spec
  const source = selectSource(spec, { sourceName, sourcePosition })

  applyHelmParameters(source, params)
  removeHelmParameters(source, unset)
  applyKustomizeImages(source, images)

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
  for (const image of images) {
    log(`set image ${image}`)
  }

  await client.updateSpec(app, spec)
  log(`Updated spec for ${app}`)
}

/** Headline like "Set 2 parameters, unset 1 parameter and set 1 image on <app>." */
function changeHeadline({ set = 0, unset = 0, images = 0 }, link) {
  const noun = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const parts = []
  if (set) parts.push(`set ${noun(set, 'parameter')}`)
  if (unset) parts.push(`unset ${noun(unset, 'parameter')}`)
  if (images) parts.push(`set ${noun(images, 'image')}`)
  const phrase =
    parts.length <= 1
      ? parts.join('')
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `**${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} on ${link}.**`
}

export async function run(client, app) {
  const parameters = core.getInput('parameters')
  const unsetParameters = core.getInput('unset-parameters')
  const kustomizeImages = core.getInput('kustomize-images')
  await setParameters(client, app, {
    parameters,
    unsetParameters,
    kustomizeImages,
    sourceName: core.getInput('source-name'),
    sourcePosition: core.getInput('source-position')
  })

  const params = toParams(parameters)
  const unset = parseList(unsetParameters)
  const images = parseList(kustomizeImages)
  const paramRows = [
    ...params.map((p) => [code(p.name), code(isSecretName(p.name) ? MASK : p.value)]),
    ...unset.map((name) => [code(name), 'removed'])
  ]
  const lines = [changeHeadline({ set: params.length, unset: unset.length, images: images.length }, appLink(app, client)), '']
  if (paramRows.length > 0) lines.push(table(['Parameter', 'Value'], paramRows))
  if (images.length > 0) {
    if (paramRows.length > 0) lines.push('')
    lines.push(table(['Kustomize image'], images.map((img) => [code(img)])))
  }
  await writeSummary('ArgoCD Set', lines)
}
