import { describe, expect, it } from '@jest/globals'
import { resolveRollbackId } from '../src/commands/rollback.js'

const history = [
  { id: 1, revision: 'aaa' },
  { id: 2, revision: 'bbb' },
  { id: 3, revision: 'ccc' } // current (newest)
]

describe('resolveRollbackId', () => {
  it('returns the previous deployment when nothing is specified', () => {
    expect(resolveRollbackId(history)).toBe(2)
  })

  it('returns the explicit id when given', () => {
    expect(resolveRollbackId(history, { id: '1' })).toBe(1)
  })

  it('resolves an id from a revision', () => {
    expect(resolveRollbackId(history, { revision: 'aaa' })).toBe(1)
  })

  it('throws on an unknown id', () => {
    expect(() => resolveRollbackId(history, { id: '99' })).toThrow(/id 99/)
  })

  it('throws on an unknown revision', () => {
    expect(() => resolveRollbackId(history, { revision: 'zzz' })).toThrow(
      /revision zzz/
    )
  })

  it('throws when there is no history', () => {
    expect(() => resolveRollbackId([])).toThrow(/no deployment history/i)
  })

  it('throws when there is only one entry and no target', () => {
    expect(() => resolveRollbackId([{ id: 5, revision: 'x' }])).toThrow(
      /no previous deployment/i
    )
  })

  it('picks the previous by id even if history is unordered', () => {
    const unordered = [
      { id: 3, revision: 'ccc' },
      { id: 1, revision: 'aaa' },
      { id: 2, revision: 'bbb' }
    ]
    expect(resolveRollbackId(unordered)).toBe(2)
  })
})
