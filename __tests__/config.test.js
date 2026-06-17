import { jest, describe, expect, it, afterEach } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { normalizeBaseUrl, parseBool, resolveConfig } = await import('../src/config.js')

describe('normalizeBaseUrl', () => {
  it('adds https scheme', () => {
    expect(normalizeBaseUrl('argocd.example.com')).toBe(
      'https://argocd.example.com'
    )
  })

  it('keeps existing scheme', () => {
    expect(normalizeBaseUrl('http://localhost:8080')).toBe(
      'http://localhost:8080'
    )
  })

  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://argocd.example.com/')).toBe(
      'https://argocd.example.com'
    )
  })
})

describe('parseBool', () => {
  it('treats common truthy strings as true', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE']) {
      expect(parseBool(v)).toBe(true)
    }
  })

  it('treats falsy strings and empty as false, honouring the fallback', () => {
    expect(parseBool('false')).toBe(false)
    expect(parseBool('')).toBe(false)
    expect(parseBool('', true)).toBe(true)
    expect(parseBool(undefined, true)).toBe(true)
  })
})

describe('resolveConfig insecure', () => {
  const ORIGINAL = process.env.ARGOCD_INSECURE

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ARGOCD_INSECURE
    else process.env.ARGOCD_INSECURE = ORIGINAL
  })

  const withInputs = (map) => core.getInput.mockImplementation((name) => map[name] ?? '')

  it('falls back to $ARGOCD_INSECURE when the input is unset', () => {
    delete process.env.ARGOCD_INSECURE
    process.env.ARGOCD_INSECURE = 'true'
    withInputs({ server: 'argo.example', 'auth-token': 't', insecure: '' })

    expect(resolveConfig().insecure).toBe(true)
  })

  it('lets the explicit input win over the env var', () => {
    process.env.ARGOCD_INSECURE = 'true'
    withInputs({ server: 'argo.example', 'auth-token': 't', insecure: 'false' })

    expect(resolveConfig().insecure).toBe(false)
  })

  it('defaults to false when neither is set', () => {
    delete process.env.ARGOCD_INSECURE
    withInputs({ server: 'argo.example', 'auth-token': 't', insecure: '' })

    expect(resolveConfig().insecure).toBe(false)
  })
})
