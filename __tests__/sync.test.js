import { describe, expect, it } from '@jest/globals'
import { buildSyncBody } from '../src/commands/sync.js'

describe('buildSyncBody', () => {
  it('is empty for default options', () => {
    expect(buildSyncBody()).toEqual({})
  })

  it('sets prune, dryRun and revision', () => {
    expect(buildSyncBody({ prune: true, dryRun: true, revision: 'abc' })).toEqual({
      prune: true,
      dryRun: true,
      revision: 'abc'
    })
  })

  it('maps boolean conveniences onto sync options', () => {
    const body = buildSyncBody({
      replace: true,
      serverSide: true,
      applyOutOfSyncOnly: true
    })
    expect(body.syncOptions.items).toEqual([
      'Replace=true',
      'ServerSideApply=true',
      'ApplyOutOfSyncOnly=true'
    ])
  })

  it('merges explicit sync options with the boolean conveniences', () => {
    const body = buildSyncBody({
      syncOptions: ['CreateNamespace=true'],
      replace: true
    })
    expect(body.syncOptions.items).toEqual([
      'CreateNamespace=true',
      'Replace=true'
    ])
  })

  it('builds an apply strategy with force', () => {
    expect(buildSyncBody({ force: true })).toEqual({
      strategy: { apply: { force: true } }
    })
  })

  it('builds a hook strategy', () => {
    expect(buildSyncBody({ strategy: 'hook' })).toEqual({
      strategy: { hook: {} }
    })
  })

  it('builds a hook strategy with force', () => {
    expect(buildSyncBody({ strategy: 'hook', force: true })).toEqual({
      strategy: { hook: { force: true } }
    })
  })
})
