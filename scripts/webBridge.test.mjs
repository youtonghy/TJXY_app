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

test('QR login remembers the native session after the login page unmounts', () => {
  const messages = [];
  const storage = new Map();
  const window = {
    location: { protocol: 'file:', href: 'file:///cache/tjxy-app.html#/login', hash: '#/login' },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    ReactNativeWebView: { postMessage: (value) => messages.push(JSON.parse(value)) },
    history: { pushState() {}, replaceState() {} },
    fetch: () => Promise.reject(new Error('Unexpected network request')),
    addEventListener() {},
  };
  runInNewContext(BRIDGE_SCRIPT, { window, document: { addEventListener() {}, querySelector: () => null }, URL, Headers });
  void window.fetch('https://example.test/Auth/Qr/Challenges', { method: 'POST', body: '{}' });
  assert.equal(storage.get('tjxy.web.rememberCredentials'), '1');
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'tjxy-session', payload: { accessToken: 'test-token', rememberLogin: false },
  }));
  assert.equal(messages.at(-1).payload.rememberLogin, true);
});
