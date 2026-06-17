import { describe, expect, it } from '@jest/globals'
import {
  resolveAppNames,
  parseRestartKinds,
  settledWithConcurrency
} from '../src/commands/deploy.js'

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
    expect(() => resolveAppNames('', '')).toThrow(/Provide `application`/)
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

describe('settledWithConcurrency', () => {
  it('preserves input order and returns settled results', async () => {
    const out = await settledWithConcurrency([1, 2, 3], 2, async (n) => n * 10)
    expect(out).toEqual([
      { status: 'fulfilled', value: 10 },
      { status: 'fulfilled', value: 20 },
      { status: 'fulfilled', value: 30 }
    ])
  })

  it('captures a worker failure as a rejected entry without aborting the batch', async () => {
    const out = await settledWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    expect(out[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(out[1].status).toBe('rejected')
    expect(out[1].reason.message).toBe('boom')
    expect(out[2]).toEqual({ status: 'fulfilled', value: 3 })
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const worker = async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    }
    await settledWithConcurrency([1, 2, 3, 4, 5, 6], 2, worker)
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('runs everything when the limit covers the whole batch', async () => {
    const out = await settledWithConcurrency([1, 2], 8, async (n) => n)
    expect(out).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 }
    ])
  })
})
