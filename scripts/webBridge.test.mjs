import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { BRIDGE_SCRIPT } from '../apps/mobile/src/webBridgeScript.ts';

test('hash-router playback opens the native player with the signed-in session', () => {
  const messages = [];
  const navigations = [];
  const values = new Map([
    ['tjxy.api.baseUrl', 'https://example.test'],
    ['tjxy.web.token', 'test-token'],
    ['tjxy.web.deviceId', 'test-device'],
  ]);
  const window = {
    location: { protocol: 'file:', href: 'file:///cache/tjxy-app.html#/app/', hash: '#/app/' },
    localStorage: { getItem: (key) => values.get(key) },
    sessionStorage: { getItem: (key) => values.get(key) },
    ReactNativeWebView: { postMessage: (value) => messages.push(JSON.parse(value)) },
    history: {
      pushState: (...args) => navigations.push(args),
      replaceState: (...args) => navigations.push(args),
    },
    fetch: () => Promise.reject(new Error('Unexpected network request')),
    addEventListener() {},
  };
  runInNewContext(BRIDGE_SCRIPT, { window, document: { addEventListener() {} }, URL });
  window.history.pushState({}, '', '#/app/play/item-1?libraryId=library-1');
  assert.equal(navigations.length, 0);
  assert.deepEqual(messages, [{
    type: 'tjxy-native-play',
    payload: {
      itemId: 'item-1', libraryId: 'library-1',
      session: { serverOrigin: 'https://example.test', accessToken: 'test-token', deviceId: 'test-device' },
    },
  }]);
  window.history.pushState({}, '', '#/app/search');
  assert.equal(navigations.length, 1);
});
