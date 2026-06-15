import { describe, expect, it } from '@jest/globals'
import { normalizeBaseUrl, parseBool } from '../src/config.js'

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
