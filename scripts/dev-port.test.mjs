import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { findAvailablePort } from '../apps/desktop/scripts/dev-port.mjs';

test('skips an occupied port without stopping or reusing its server', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const occupied = server.address().port;
  const port = await findAvailablePort(occupied);
  assert.ok(port > occupied);
  assert.equal(server.listening, true);
  assert.equal(await findAvailablePort(port), port);
});
