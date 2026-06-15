import { describe, expect, it } from '@jest/globals'
import { resolveAppNames, parseRestartKinds } from '../src/commands/deploy.js'

describe('resolveAppNames', () => {
  it('returns the single app when no list is given', () => {
    expect(resolveAppNames('app.stage.comments', '')).toEqual([
      'app.stage.comments'
    ])
  })

  it('parses a JSON array of names', () => {
    expect(resolveAppNames('', '["app.a", "app.b"]')).toEqual(['app.a', 'app.b'])
  })

  it('parses a newline-separated list', () => {
    expect(resolveAppNames('', 'app.a\napp.b\n')).toEqual(['app.a', 'app.b'])
  })

  it('parses a comma-separated list', () => {
    expect(resolveAppNames('', 'app.a, app.b ,app.c')).toEqual([
      'app.a',
      'app.b',
      'app.c'
    ])
  })

  it('prefers applications over app when both are set', () => {
    expect(resolveAppNames('app.single', 'app.a\napp.b')).toEqual([
      'app.a',
      'app.b'
    ])
  })

  it('throws when neither app nor applications is provided', () => {
    expect(() => resolveAppNames('', '')).toThrow(/Provide `app`/)
  })

  it('throws on a JSON array containing non-strings', () => {
    expect(() => resolveAppNames('', '[{"app":"x"}]')).toThrow(
      /array of strings/
    )
  })
})

describe('parseRestartKinds', () => {
  it('is disabled by default / for falsey values', () => {
    expect(parseRestartKinds('')).toEqual([])
    expect(parseRestartKinds('false')).toEqual([])
    expect(parseRestartKinds('off')).toEqual([])
  })

  it('accepts a single kind', () => {
    expect(parseRestartKinds('StatefulSet')).toEqual(['StatefulSet'])
  })

  it('accepts a comma-separated list of kinds', () => {
    expect(parseRestartKinds('Deployment, StatefulSet ,DaemonSet')).toEqual([
      'Deployment',
      'StatefulSet',
      'DaemonSet'
    ])
  })
})
