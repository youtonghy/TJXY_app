import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeSources } from '../src/playback.ts';

test('native source selection requires a URL and prefers finite direct-play VOD', () => {
  const selected = nativeSources([
    { Id: 'missing-url', Container: 'mp4', SupportsDirectPlay: true },
    { Id: 'live', Container: 'mp4', IsLive: true, DirectStreamUrl: '/live' },
    { Id: 'mkv', Container: 'mkv', DirectStreamUrl: '/mkv' },
    { Id: 'default', Container: 'mp4', IsDefault: true, DirectStreamUrl: '/mp4' },
  ]);

  assert.deepEqual(selected.map((source) => source.Id), ['default', 'mkv']);
});
