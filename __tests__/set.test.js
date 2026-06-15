import { describe, expect, it } from '@jest/globals'
import { parseParameters, applyHelmParameters } from '../src/commands/set.js'

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
})
