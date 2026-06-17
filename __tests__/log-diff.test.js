import { describe, expect, it } from '@jest/globals'
import { logDiff } from '../src/commands/diff.js'
import { diffManagedResources } from '../src/diff.js'

/** Collect the lines logDiff would emit, via the injectable `log` sink. */
function capture(result, opts = {}) {
  const lines = []
  logDiff('app.stage.comments', result, { log: (s) => lines.push(s), ...opts })
  return lines
}

const result = diffManagedResources([
  {
    group: 'apps',
    kind: 'Deployment',
    name: 'comments',
    namespace: 'comments',
    normalizedLiveState: JSON.stringify({ spec: { image: 'app:old' } }),
    predictedLiveState: JSON.stringify({ spec: { image: 'app:new' } })
  },
  {
    kind: 'Secret',
    name: 'creds',
    namespace: 'comments',
    normalizedLiveState: JSON.stringify({ data: { password: 'b2xk' } }),
    predictedLiveState: JSON.stringify({ data: { password: 'bmV3' } })
  }
])

describe('logDiff', () => {
  it('lists changes as "type: path" by default (no values)', () => {
    const lines = capture(result)
    expect(lines).toContain('      changed: spec.image')
    expect(lines.some((l) => l.includes('app:old'))).toBe(false)
  })

  it('renders -/+ value lines under each resource when unified', () => {
    const lines = capture(result, { unified: true })
    expect(lines).toContain('  modified Deployment/comments/comments')
    expect(lines).toContain('      - spec.image: app:old')
    expect(lines).toContain('      + spec.image: app:new')
  })

  it('masks Secret values in the unified log', () => {
    const lines = capture(result, { unified: true })
    expect(lines).toContain('      - data.password: ***')
    expect(lines).toContain('      + data.password: ***')
    expect(lines.some((l) => l.includes('b2xk') || l.includes('bmV3'))).toBe(false)
  })

  it('reports no differences without iterating resources', () => {
    const same = JSON.stringify({ a: 1 })
    const none = diffManagedResources([{ kind: 'A', name: '1', normalizedLiveState: same, predictedLiveState: same }])
    expect(capture(none, { unified: true })).toEqual(['No differences for app.stage.comments.'])
  })
})
