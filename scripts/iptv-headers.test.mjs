import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { iptvHeaders as mobileHeaders } from '../apps/mobile/src/iptvHeaders.ts';
const { iptvHeaders: desktopHeaders } = createRequire(import.meta.url)('../apps/desktop/electron/iptv-headers.cjs');

test('IPTV bridge only synthesizes public metadata for the Web signing host', () => {
  for (const target of ['https://player-api.yangshipin.cn/v1/player/auth', 'https://example.test']) {
    const headers = { 'X-TJXY-IPTV-Guid': 'public_guid', Referer: 'https://www.yangshipin.cn/' };
    const mobile = mobileHeaders(target, headers);
    const desktop = desktopHeaders(new URL(target), headers);
    assert.deepEqual(mobile, desktop);
    assert.equal('X-TJXY-IPTV-Guid' in mobile, false);
    assert.equal(Boolean(mobile.Cookie), target.includes('player-api.yangshipin.cn'));
  }
  assert.equal(mobileHeaders('https://player-api.yangshipin.cn', { Cookie: 'session=secret', 'X-TJXY-IPTV-Guid': 'bad;value' }).Cookie, undefined);
});
