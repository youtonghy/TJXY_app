import assert from 'node:assert/strict';
import test from 'node:test';

function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('empty origin');
  const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid origin');
  return `${url.protocol}//${url.host}`;
}

function resolveApiUrl(path: string, baseUrl: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('invalid path');
  if (!baseUrl) throw new Error('missing api base url');
  return new URL(path, `${baseUrl}/`).toString();
}

test('joins relative API paths', () => {
  assert.equal(normalizeOrigin('http://127.0.0.1:8096/'), 'http://127.0.0.1:8096');
  assert.equal(resolveApiUrl('/Users/Me', 'http://127.0.0.1:8096'), 'http://127.0.0.1:8096/Users/Me');
});

test('rejects protocol-relative paths', () => {
  assert.throws(() => resolveApiUrl('//evil', 'http://127.0.0.1:8096'));
});
