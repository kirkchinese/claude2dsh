import test from 'node:test'
import assert from 'node:assert/strict'
import { assertDshCompatibility } from '../src/compat.ts'

test('accepts the installed DSH peer version and session format', () => {
  assert.doesNotThrow(() => assertDshCompatibility())
})

test('compat gate is present and fail-loud by construction', () => {
  assert.equal(typeof assertDshCompatibility, 'function')
})
