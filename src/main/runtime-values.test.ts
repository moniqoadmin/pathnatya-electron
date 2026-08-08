import { describe, expect, it } from 'vitest'
import { getRuntimeValueA, getRuntimeValueB } from './runtime-values'

describe('runtime values', () => {
  it('getRuntimeValueA returns only permitted values', () => {
    const allowed = new Set([73, 184, 267])

    for (let index = 0; index < 1_000; index += 1) {
      expect(allowed.has(getRuntimeValueA())).toBe(true)
    }
  })

  it('getRuntimeValueB returns only permitted values', () => {
    const allowed = new Set([41, 156, 298])

    for (let index = 0; index < 1_000; index += 1) {
      expect(allowed.has(getRuntimeValueB())).toBe(true)
    }
  })
})
