import { describe, expect, it } from '@jest/globals'
import { appLink } from '../src/summary.js'

describe('appLink', () => {
  it('returns just the label when the server is unknown', () => {
    expect(appLink('app.stage.comments', {})).toBe('`app.stage.comments`')
  })

  it('links to /applications/<name> when no namespace is set', () => {
    const out = appLink('app.stage.comments', { baseUrl: 'https://argo.example' })
    expect(out).toContain('(https://argo.example/applications/app.stage.comments)')
    expect(out).not.toContain('/applications/argocd/')
  })

  it('adds a namespace segment only when appNamespace is set', () => {
    const out = appLink('comments', {
      baseUrl: 'https://argo.example',
      appNamespace: 'team-a'
    })
    expect(out).toContain('(https://argo.example/applications/team-a/comments)')
  })

  it('url-encodes the namespace and name', () => {
    const out = appLink('a b', { baseUrl: 'https://argo.example', appNamespace: 'n s' })
    expect(out).toContain('/applications/n%20s/a%20b)')
  })
})
