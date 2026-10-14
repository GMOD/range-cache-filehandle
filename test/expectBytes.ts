import { expect } from 'vitest'

/**
 * `expect(bytes).toEqual(other)` walks a typed array element by element through
 * the structural-equality machinery, which on the 1.25 MB ranges below costs
 * seconds per assertion and timed the suite out. Compare the bytes directly and
 * hand the first difference to `expect` only when there is one, so a failure
 * still reads as a failure rather than as a wall of numbers.
 */
export function expectBytes(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      expect({ offset: i, byte: actual[i] }).toEqual({
        offset: i,
        byte: expected[i],
      })
      return
    }
  }
}
