import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicBranding } from '../src/catalog.ts';
import type { ClientSession } from '../src/http.ts';

test('maps public branding and theme settings used by mobile', async () => {
  const value = await getPublicBranding(client({
    SiteTitle: ' Cinema ', SiteSubtitle: ' Private screenings ', LogoUrl: '/logo.webp',
    Theme: { Id: 'cinema', SchemaVersion: 1, Options: { accent: 'crimson' }, Revision: 4 },
  }));

  assert.deepEqual(value, {
    SiteTitle: 'Cinema', SiteSubtitle: 'Private screenings', LogoUrl: '/logo.webp',
    Theme: { id: 'cinema', schemaVersion: 1, options: { accent: 'crimson' }, revision: 4 },
  });
});

test('falls back safely when public theme settings are malformed', async () => {
  const value = await getPublicBranding(client({ Theme: { Id: '', SchemaVersion: 0, Options: [], Revision: -1 } }));
  assert.deepEqual(value.Theme, { id: 'classic', schemaVersion: 1, options: {}, revision: 0 });
});

function client(body: unknown): ClientSession {
  return {
    baseUrl: 'https://example.test', token: null, deviceId: 'device',
    clientName: 'test', deviceName: 'test',
    fetch: async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  };
}
