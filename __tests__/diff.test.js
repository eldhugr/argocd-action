import { describe, expect, it } from '@jest/globals'
import { deepDiff, diffResource, diffManagedResources } from '../src/diff.js'

describe('deepDiff', () => {
  it('produces no diff for identical objects regardless of key order', () => {
    const a = { a: 1, b: { c: [1, 2, 3] } }
    const b = { b: { c: [1, 2, 3] }, a: 1 }
    expect(deepDiff(a, b)).toEqual([])
  })

  it('detects a changed primitive', () => {
    const diff = deepDiff({ a: 1 }, { a: 2 })
    expect(diff).toHaveLength(1)
    expect(diff[0]).toMatchObject({ type: 'changed', path: 'a' })
  })

  it('detects added and removed keys', () => {
    const diff = deepDiff({ a: 1, b: 2 }, { a: 1, c: 3 })
    const byPath = Object.fromEntries(diff.map((d) => [d.path, d.type]))
    expect(byPath.b).toBe('removed') // present live, absent target
    expect(byPath.c).toBe('added') // absent live, present target
  })

  it('detects array length differences', () => {
    const diff = deepDiff([1, 2], [1, 2, 3])
    expect(diff).toHaveLength(1)
    expect(diff[0]).toMatchObject({ type: 'added', path: '[2]' })
  })
})

describe('diffResource', () => {
  it('flags an image tag change as modified', () => {
    const res = diffResource({
      kind: 'Deployment',
      name: 'comments',
      namespace: 'comments',
      normalizedLiveState: JSON.stringify({ spec: { image: 'app:abc' } }),
      predictedLiveState: JSON.stringify({ spec: { image: 'app:def' } })
    })
    expect(res.changed).toBe(true)
    expect(res.status).toBe('modified')
  })

  it('reports no change when states are equal', () => {
    const state = JSON.stringify({ spec: { replicas: 2 } })
    const res = diffResource({
      kind: 'Deployment',
      name: 'x',
      normalizedLiveState: state,
      predictedLiveState: state
    })
    expect(res.changed).toBe(false)
    expect(res.status).toBe('same')
  })

  it('treats a resource with no live state as added', () => {
    const res = diffResource({
      kind: 'ConfigMap',
      name: 'new',
      normalizedLiveState: '',
      predictedLiveState: JSON.stringify({ data: { k: 'v' } })
    })
    expect(res.status).toBe('added')
    expect(res.changed).toBe(true)
  })

  it('treats a resource with no target state as pruned', () => {
    const res = diffResource({
      kind: 'ConfigMap',
      name: 'old',
      normalizedLiveState: JSON.stringify({ data: { k: 'v' } }),
      predictedLiveState: ''
    })
    expect(res.status).toBe('pruned')
    expect(res.changed).toBe(true)
  })
})

describe('diffManagedResources', () => {
  it('aggregates hasDiff across resources', () => {
    const same = JSON.stringify({ a: 1 })
    const out = diffManagedResources([
      {
        kind: 'A',
        name: '1',
        normalizedLiveState: same,
        predictedLiveState: same
      },
      {
        kind: 'B',
        name: '2',
        normalizedLiveState: JSON.stringify({ a: 1 }),
        predictedLiveState: JSON.stringify({ a: 2 })
      }
    ])
    expect(out.hasDiff).toBe(true)
    expect(out.resources.filter((r) => r.changed)).toHaveLength(1)
  })

  it('reports no diff when every resource matches', () => {
    const same = JSON.stringify({ a: 1 })
    const out = diffManagedResources([
      {
        kind: 'A',
        name: '1',
        normalizedLiveState: same,
        predictedLiveState: same
      }
    ])
    expect(out.hasDiff).toBe(false)
  })
})
