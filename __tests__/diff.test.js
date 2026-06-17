import { describe, expect, it } from '@jest/globals'
import { deepDiff, diffResource, diffManagedResources, renderUnifiedDiff, imageChanges } from '../src/diff.js'

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

  it('captures before/after values per entry', () => {
    const diff = deepDiff({ a: 1, b: 2 }, { a: 9, c: 3 })
    const byPath = Object.fromEntries(diff.map((d) => [d.path, d]))
    expect(byPath.a).toMatchObject({ type: 'changed', before: 1, after: 9 })
    expect(byPath.b).toMatchObject({ type: 'removed', before: 2 })
    expect(byPath.c).toMatchObject({ type: 'added', after: 3 })
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

describe('renderUnifiedDiff', () => {
  const modified = (kind = 'Deployment') =>
    diffResource({
      group: 'apps',
      kind,
      name: 'comments',
      namespace: 'comments',
      normalizedLiveState: JSON.stringify({ spec: { image: 'app:old', replicas: 2 } }),
      predictedLiveState: JSON.stringify({ spec: { image: 'app:new', replicas: 2 } })
    })

  it('renders -/+ lines under a hunk header for a modified resource', () => {
    const out = renderUnifiedDiff([modified()])
    expect(out).toContain('@@ Deployment/comments/comments @@')
    expect(out).toContain('- spec.image: app:old')
    expect(out).toContain('+ spec.image: app:new')
  })

  it('skips unchanged resources and returns empty when nothing changed', () => {
    const same = JSON.stringify({ spec: { image: 'app:x' } })
    const res = diffResource({ kind: 'Deployment', name: 'x', normalizedLiveState: same, predictedLiveState: same })
    expect(renderUnifiedDiff([res])).toBe('')
  })

  it('masks the values of Secret resources but still names the changed field', () => {
    const out = renderUnifiedDiff([
      diffResource({
        kind: 'Secret',
        name: 'creds',
        namespace: 'comments',
        normalizedLiveState: JSON.stringify({ data: { password: 'b2xk' } }),
        predictedLiveState: JSON.stringify({ data: { password: 'bmV3' } })
      })
    ])
    expect(out).toContain('data.password')
    expect(out).toContain('- data.password: ***')
    expect(out).toContain('+ data.password: ***')
    expect(out).not.toContain('b2xk')
    expect(out).not.toContain('bmV3')
  })

  it('summarises added and pruned resources on a single line', () => {
    const added = diffResource({ kind: 'ConfigMap', name: 'new', normalizedLiveState: '', predictedLiveState: JSON.stringify({ data: { k: 'v' } }) })
    const pruned = diffResource({ kind: 'ConfigMap', name: 'old', normalizedLiveState: JSON.stringify({ data: { k: 'v' } }), predictedLiveState: '' })
    expect(renderUnifiedDiff([added])).toContain('@@ ConfigMap/new (added) @@')
    expect(renderUnifiedDiff([added])).toContain('+ (resource created)')
    expect(renderUnifiedDiff([pruned])).toContain('@@ ConfigMap/old (pruned) @@')
    expect(renderUnifiedDiff([pruned])).toContain('- (resource deleted)')
  })

  it('caps the rendered fields per resource and notes the remainder', () => {
    const live = {}
    const target = {}
    for (let i = 0; i < 5; i++) {
      live[`f${i}`] = i
      target[`f${i}`] = i + 100
    }
    const res = diffResource({
      kind: 'ConfigMap',
      name: 'big',
      normalizedLiveState: JSON.stringify({ data: live }),
      predictedLiveState: JSON.stringify({ data: target })
    })
    const out = renderUnifiedDiff([res], { maxFields: 2 })
    expect(out).toContain('... and 3 more field(s)')
  })
})

describe('imageChanges', () => {
  const deployment = (live, target) =>
    diffResource({
      group: 'apps',
      kind: 'Deployment',
      name: 'web',
      namespace: 'web',
      normalizedLiveState: JSON.stringify(live),
      predictedLiveState: JSON.stringify(target)
    })

  it('extracts a container image transition', () => {
    const r = deployment(
      { spec: { template: { spec: { containers: [{ name: 'web', image: 'repo/web:old' }] } } } },
      { spec: { template: { spec: { containers: [{ name: 'web', image: 'repo/web:new' }] } } } }
    )
    expect(imageChanges([r])).toEqual([{ before: 'repo/web:old', after: 'repo/web:new' }])
  })

  it('ignores non-image field changes', () => {
    const r = deployment({ spec: { replicas: 1 } }, { spec: { replicas: 2 } })
    expect(imageChanges([r])).toEqual([])
  })

  it('dedupes identical transitions across resources', () => {
    const a = deployment({ spec: { image: 'x:1' } }, { spec: { image: 'x:2' } })
    const b = deployment({ spec: { image: 'x:1' } }, { spec: { image: 'x:2' } })
    expect(imageChanges([a, b])).toEqual([{ before: 'x:1', after: 'x:2' }])
  })

  it('does not match lookalike fields like imagePullPolicy', () => {
    const r = deployment(
      { spec: { template: { spec: { containers: [{ imagePullPolicy: 'Always' }] } } } },
      { spec: { template: { spec: { containers: [{ imagePullPolicy: 'IfNotPresent' }] } } } }
    )
    expect(imageChanges([r])).toEqual([])
  })
})
