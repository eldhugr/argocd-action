import { describe, expect, it } from '@jest/globals'
import { parseParameters, applyHelmParameters, removeHelmParameters, applyKustomizeImages } from '../src/commands/set.js'
import { isSecretName } from '../src/summary.js'

describe('parseParameters', () => {
  it('parses name=value pairs', () => {
    const out = parseParameters(
      'comments.release.refName=main\ncomments.release.commitSHA=abc123'
    )
    expect(out).toEqual([
      { name: 'comments.release.refName', value: 'main' },
      { name: 'comments.release.commitSHA', value: 'abc123' }
    ])
  })

  it('keeps "=" inside values', () => {
    expect(parseParameters('foo=a=b=c')).toEqual([
      { name: 'foo', value: 'a=b=c' }
    ])
  })

  it('skips blank lines and comments', () => {
    expect(parseParameters('\n# comment\nfoo=bar\n')).toEqual([
      { name: 'foo', value: 'bar' }
    ])
  })

  it('throws when "=" is missing', () => {
    expect(() => parseParameters('novalue')).toThrow(/expected name=value/)
  })
})

describe('applyHelmParameters', () => {
  it('adds new parameters', () => {
    const source = {}
    applyHelmParameters(source, [{ name: 'a', value: '1' }])
    expect(source.helm.parameters).toEqual([{ name: 'a', value: '1' }])
  })

  it('replaces existing parameters by name', () => {
    const source = {
      helm: {
        parameters: [
          { name: 'a', value: 'old' },
          { name: 'b', value: '2' }
        ]
      }
    }
    applyHelmParameters(source, [{ name: 'a', value: 'new' }])
    expect(source.helm.parameters).toEqual([
      { name: 'a', value: 'new' },
      { name: 'b', value: '2' }
    ])
  })

  it('is a no-op for empty params and adds no helm block', () => {
    const source = {}
    applyHelmParameters(source, [])
    expect(source).toEqual({})
  })
})

describe('applyKustomizeImages', () => {
  it('adds new image overrides', () => {
    const source = {}
    applyKustomizeImages(source, ['nginx=nginx:1.21'])
    expect(source.kustomize.images).toEqual(['nginx=nginx:1.21'])
  })

  it('replaces an existing override for the same image (rename form)', () => {
    const source = { kustomize: { images: ['nginx=nginx:1.20', 'redis:6'] } }
    applyKustomizeImages(source, ['nginx=nginx:1.21'])
    expect(source.kustomize.images).toEqual(['nginx=nginx:1.21', 'redis:6'])
  })

  it('replaces by name for the tag-only form, and appends new images', () => {
    const source = { kustomize: { images: ['redis:6'] } }
    applyKustomizeImages(source, ['redis:7', 'busybox:1.36'])
    expect(source.kustomize.images).toEqual(['redis:7', 'busybox:1.36'])
  })

  it('is a no-op for empty input and adds no kustomize block', () => {
    const source = {}
    applyKustomizeImages(source, [])
    expect(source).toEqual({})
  })
})

describe('removeHelmParameters', () => {
  it('removes parameters by name and leaves the rest in order', () => {
    const source = { helm: { parameters: [{ name: 'a', value: '1' }, { name: 'b', value: '2' }, { name: 'c', value: '3' }] } }
    removeHelmParameters(source, ['b'])
    expect(source.helm.parameters).toEqual([{ name: 'a', value: '1' }, { name: 'c', value: '3' }])
  })

  it('is a no-op when the source has no helm parameters', () => {
    const source = {}
    expect(() => removeHelmParameters(source, ['a'])).not.toThrow()
    expect(source).toEqual({})
  })

  it('ignores names that are not present', () => {
    const source = { helm: { parameters: [{ name: 'a', value: '1' }] } }
    removeHelmParameters(source, ['x'])
    expect(source.helm.parameters).toEqual([{ name: 'a', value: '1' }])
  })
})

describe('isSecretName', () => {
  it('flags secret-looking parameter names (separators/case ignored)', () => {
    for (const name of ['db.password', 'apiKey', 'api-key', 'API_TOKEN', 'tls.key', 'auth.secret', 'oauthToken', 'signingKey']) {
      expect(isSecretName(name)).toBe(true)
    }
  })

  it('flags "auth" only as the leaf key, not an app/chart name segment', () => {
    // basicAuth / oauth as the leaf still read as secret-like.
    for (const name of ['app.basicAuth', 'service.oauth']) {
      expect(isSecretName(name)).toBe(true)
    }
    // An "auth" carried by an ancestor segment (the app name) must not mask the
    // commit SHA / ref - this was masking auth-web deploys everywhere in the job.
    for (const name of ['auth-web.release.commitSHA', 'auth-web.release.refName', 'oauth-proxy.image.tag']) {
      expect(isSecretName(name)).toBe(false)
    }
  })

  it('leaves ordinary parameter names visible', () => {
    for (const name of ['image.tag', 'replicaCount', 'ingress.host', 'comments.release.refName']) {
      expect(isSecretName(name)).toBe(false)
    }
  })
})
