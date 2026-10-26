// Minimal `vite-plus/test` shim on node:test, for the guide's unit tests only.
import assert from 'node:assert/strict'
import { describe as nodeDescribe, it as nodeIt } from 'node:test'

export function describe(name: string, run: () => void) {
  void nodeDescribe(name, run)
}

export function it(name: string, run: () => void | Promise<void>) {
  void nodeIt(name, run)
}

function isSubset(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== 'object' || expected === null) return Object.is(actual, expected)
  if (typeof actual !== 'object' || actual === null) return false
  return Object.entries(expected).every(([key, value]) => isSubset((actual as Record<string, unknown>)[key], value))
}

function createMatchers(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toBeCloseTo: (expected: number, digits = 2) => assert.ok(Math.abs(Number(actual) - expected) < 10 ** -digits / 2, `${String(actual)} is not close to ${expected}`),
    toBeLessThan: (expected: number) => assert.ok(Number(actual) < expected, `${String(actual)} is not less than ${expected}`),
    toHaveLength: (expected: number) => assert.equal((actual as { length?: number } | undefined)?.length, expected),
    toMatchObject: (expected: object) => assert.ok(isSubset(actual, expected), `${JSON.stringify(actual)} does not match ${JSON.stringify(expected)}`),
  }
}

export const expect = Object.assign(createMatchers, { hasAssertions: () => undefined })
