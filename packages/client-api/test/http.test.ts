import assert from 'node:assert/strict';
import test from 'node:test';

import { ClientApiError, clientErrorKind } from '../src/http.ts';

test('maps HTTP 429 responses to a rate-limit error', () => {
  assert.equal(clientErrorKind(429), 'rate-limit');
  assert.equal(new ClientApiError(429, 'rate-limit').message, 'The request limit has been reached.');
});
