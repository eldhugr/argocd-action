import { jest, describe, expect, it } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { buildSyncBody, consolidateSyncOptions, warnUnknownSyncOptions } =
  await import('../src/commands/sync.js')

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

  it('drops a duplicate produced by a flag and the same raw option', () => {
    const body = buildSyncBody({
      syncOptions: ['ServerSideApply=true'],
      serverSide: true
    })
    expect(body.syncOptions.items).toEqual(['ServerSideApply=true'])
  })

  it('lets the boolean flag override a conflicting raw option', () => {
    const body = buildSyncBody({
      syncOptions: ['ServerSideApply=false'],
      serverSide: true
    })
    expect(body.syncOptions.items).toEqual(['ServerSideApply=true'])
  })
})

describe('consolidateSyncOptions', () => {
  it('leaves distinct keys untouched and preserves order', () => {
    expect(
      consolidateSyncOptions(['CreateNamespace=true', 'Validate=false'])
    ).toEqual(['CreateNamespace=true', 'Validate=false'])
  })

  it('drops exact duplicates', () => {
    expect(
      consolidateSyncOptions(['Replace=true', 'Replace=true'])
    ).toEqual(['Replace=true'])
  })

  it('keeps the last value when a key conflicts', () => {
    expect(
      consolidateSyncOptions(['Validate=true', 'Validate=false'])
    ).toEqual(['Validate=false'])
  })

  it('handles bare (valueless) options', () => {
    expect(consolidateSyncOptions(['Prune', 'Prune'])).toEqual(['Prune'])
  })
})

describe('warnUnknownSyncOptions', () => {
  it('does not warn on recognised options', () => {
    warnUnknownSyncOptions(['CreateNamespace=true', 'ServerSideApply=true'])
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('warns once per unrecognised key', () => {
    warnUnknownSyncOptions(['ServerSideAply=true'])
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('ServerSideAply')
    )
  })

  it('does not warn on flag-derived options via buildSyncBody', () => {
    buildSyncBody({ replace: true, serverSide: true, applyOutOfSyncOnly: true })
    expect(core.warning).not.toHaveBeenCalled()
  })
})
