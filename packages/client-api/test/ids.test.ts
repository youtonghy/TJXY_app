import assert from 'node:assert/strict';
import test from 'node:test';
import { isAbortError, randomUuid } from '../src/ids.ts';

test('randomUuid is a RFC 4122 variant-1 UUID', () => {
  assert.match(randomUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('isAbortError accepts abort-like errors', () => {
  const abort = new Error('Aborted');
  abort.name = 'AbortError';
  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError(new Error('The operation was aborted.')), true);
  assert.equal(isAbortError(new Error('network down')), false);
});
