import { describe, expect, it } from 'vitest';
import type { IptvChannel } from './iptvChannels';
import { aesGcmEncryptB64 } from './iptvDeviceCrypto';
import {
  IptvDeviceEngine,
  isIptvDeviceChannel,
  isSessionInvalidatingError,
  livePlaybackHostNeedsSignedHeaders,
  rewritePlaylistUrls,
} from './iptvDevice';

// Deterministic harness: fake clock, seeded RNG, in-memory storage and a
// scripted fetch router that plays the upstream cloud/app/live endpoints.
const SESSION_KEY = 'session-key-under-test';
const LIVE_URL = 'http://live01.cctv.cn/hls/cctv1.m3u8';
const CDN_URL = 'http://cdn.example/live/cctv1/index.m3u8';
const CDN_PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000,\nseg1.ts\n#EXTINF:6.000,\nseg2.ts\n';

const channel: IptvChannel = {
  slug: 'cctv1',
  name: 'CCTV-1',
  sid: 'sid',
  pid: 'pid',
  defn: 'fhd',
  timeshift: true,
  liveId: 'Live-test-1',
};

const fixedBytes = (length: number) => Uint8Array.from({ length }, (_, i) => i % 256);
const jsonHeaders = { 'Content-Type': 'application/json' };

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}

function toBodyText(body: BodyInit | null | undefined): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return '';
}

function makeRouter(options: { live01Status?: number; cdnStatuses?: number[] } = {}) {
  const calls: RecordedCall[] = [];
  let sessionKey = SESSION_KEY;
  let cdnIndex = 0;
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: toBodyText(init?.body),
    });
    const respond = (value: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(value), { status, headers: jsonHeaders }));
    if (url.includes('collect.cctv.cn')) return respond({});
    if (url.includes('dictionary')) return respond({});
    if (url.includes('app/start')) {
      // The engine derives the AES key from the X-Fingerprint it sent.
      const fp = headers['X-Fingerprint'] ?? '';
      return respond({ data: { key: aesGcmEncryptB64(sessionKey, fp.slice(0, 32), fixedBytes) } });
    }
    if (url.includes('data/message/single')) return respond({ result: 0 });
    if (url.includes('device/v2/get')) return respond({ result: 0, data: { guid: 'cloud-guid-1' } });
    if (url.includes('device/v2/register')) return respond({ result: 0, data: { guid: 'cloud-guid-1' } });
    if (url.includes('api/index')) return respond({});
    if (url.includes('drm/config')) return respond({});
    if (url.includes('version/config')) return respond({});
    if (url.includes('live/v1/01')) {
      const status = options.live01Status ?? 200;
      if (status !== 200) return respond({ error: 'bad' }, status);
      return respond({
        data: {
          videoList: [
            { url: aesGcmEncryptB64(LIVE_URL, sessionKey, fixedBytes), rate: '36p', rateName: 'UHD' },
            { url: 'http://fallback.invalid/lo.m3u8', rate: '15p' },
          ],
        },
      });
    }
    if (url.includes('live/v1/02')) {
      return respond({ data: { appSecret: aesGcmEncryptB64('vdn-secret', sessionKey, fixedBytes) } });
    }
    if (url.includes('getstream')) return respond({ succeed: '1', url: CDN_URL });
    if (url === CDN_URL) {
      const status = options.cdnStatuses?.[cdnIndex] ?? 200;
      if (options.cdnStatuses) cdnIndex += 1;
      if (status !== 200) return Promise.resolve(new Response('expired', { status }));
      return Promise.resolve(new Response(CDN_PLAYLIST, { status: 200 }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
  return { calls, fetchImpl, setSessionKey: (key: string) => { sessionKey = key; } };
}

function makeEngine(router: { fetchImpl: (url: string, init?: RequestInit) => Promise<Response> }, nowRef: { t: number }) {
  return new IptvDeviceEngine({
    fetchImpl: router.fetchImpl,
    now: () => nowRef.t,
    randomBytes: fixedBytes,
    storage: makeStorage(),
    sleep: () => Promise.resolve(),
  });
}

describe('iptvDeviceEngine happy path', () => {
  it('completes the v9 critical handshake before channel resolution', async () => {
    const nowRef = { t: 1_700_000_000_000 };
    const router = makeRouter();
    const engine = makeEngine(router, nowRef);
    const playlist = await engine.fetchPlaylist(channel);

    expect(playlist).toContain('http://cdn.example/live/cctv1/seg1.ts');
    expect(playlist).toContain('http://cdn.example/live/cctv1/seg2.ts');
    const urls = router.calls.map((call) => call.url);
    expect(urls[0]).toContain('app/start');
    expect(urls[1]).toContain('device/v2/get');
    expect(urls[2]).toContain('data/message/single');
    const business = urls.filter((url) => /live\/v1|\/getstream|cdn\.example/.test(url));
    expect(business).toHaveLength(4);
    ['live/v1/01', 'live/v1/02', 'getstream', CDN_URL].forEach((needle, index) => {
      expect(business[index]).toContain(needle);
    });
  });

  it('reuses the cached entry: a second playlist fetch only re-GETs the CDN playlist', async () => {
    const nowRef = { t: 1_700_000_000_000 };
    const router = makeRouter();
    const engine = makeEngine(router, nowRef);
    await engine.fetchPlaylist(channel);
    router.calls.length = 0;
    nowRef.t += 10_000;
    await engine.fetchPlaylist(channel);
    expect(router.calls.filter((call) => /app\/start|live\/v1|\/getstream|cdn\.example/.test(call.url)).map((call) => call.url)).toEqual([CDN_URL]);
  });

  it('attaches signed playback headers for segments under the resolved prefix', async () => {
    const nowRef = { t: 1_700_000_000_000 };
    const router = makeRouter();
    const engine = makeEngine(router, nowRef);
    await engine.fetchPlaylist(channel);
    const signed = engine.segmentHeaders('http://cdn.example/live/cctv1/seg9.ts');
    expect(signed.APPID).toBe('9f5c54c4ed0e50109b800f7e28fec205');
    expect(signed.APPSIGN).toBeTruthy();
    expect(signed.APPRANDOMSTR).toBeTruthy();
    const vdnCall = router.calls.find((call) => call.url.includes('getstream'));
    expect(vdnCall?.headers.APPID).toBe('9f5c54c4ed0e50109b800f7e28fec205');
    expect(vdnCall?.headers.APPSIGN).toBe(signed.APPSIGN);
    // Unrelated hosts keep the anonymous JCE-style default headers.
    expect(engine.segmentHeaders('http://other.example/x.ts').APPSIGN).toBeUndefined();
  });

  it('skips the whole device path for channels without a liveId', async () => {
    const nowRef = { t: 1_700_000_000_000 };
    const router = makeRouter();
    const engine = makeEngine(router, nowRef);
    await expect(engine.fetchPlaylist({ ...channel, slug: 'cctv6', liveId: undefined })).rejects.toThrow('live id');
    expect(router.calls).toHaveLength(0);
    expect(isIptvDeviceChannel(channel)).toBe(true);
    expect(isIptvDeviceChannel({ ...channel, liveId: undefined })).toBe(false);
  });
});

describe('iptvDeviceEngine failure handling', () => {
  it('enters cooldown after a resolve failure and retries after it elapses', async () => {
    const nowRef = { t: 1_700_000_000_000 };
    const router = makeRouter({ live01Status: 400 });
    const engine = makeEngine(router, nowRef);
    await expect(engine.fetchPlaylist(channel)).rejects.toThrow('live/v1/01 http 400');
    const live01Calls = router.calls.filter((call) => call.url.includes('live/v1/01')).length;
    expect(live01Calls).toBe(1);

    // Inside the 30s cooldown the engine refuses without new live calls.
    nowRef.t += 5_000;
    await expect(engine.fetchPlaylist(channel)).rejects.toThrow('cooldown');
    expect(router.calls.filter((call) => call.url.includes('live/v1/01'))).toHaveLength(live01Calls);

    // After the cooldown a fresh attempt re-bootstraps the dropped session.
    nowRef.t += 30_000;
    await expect(engine.fetchPlaylist(channel)).rejects.toThrow('live/v1/01 http 400');
    expect(router.calls.filter((call) => call.url.includes('live/v1/01'))).toHaveLength(2);
    expect(router.calls.some((call) => call.url.includes('app/start'))).toBe(true);
  });

  it('invalidates the session on decrypt-level failures', () => {
    for (const [message, expected] of [
      ['app/start http 400: x', true],
      ['live/v1/01 http 400', true],
      ['live/v1/01 http 500', false],
      ['vdn http 500', false],
      ['AES-GCM decrypt failed', true],
      ['missing encrypted session key', true],
      ['vdn http 401', true],
      ['vdn http 403', true],
      ['no usable url', true],
      ['missing videos', true],
      ['upstream m3u8 http 404', false],
      ['upstream m3u8 http 403', false],
    ] as const) {
      expect(isSessionInvalidatingError(message), message).toBe(expected);
    }
  });

  it('re-resolves once when the CDN playlist expires and then cools down', async () => {
    const nowRef = { t: 1_700_000_000_000 };
    const recovered = makeRouter({ cdnStatuses: [403, 200] });
    const engine = makeEngine(recovered, nowRef);
    const playlist = await engine.fetchPlaylist(channel);
    expect(playlist).toContain('seg1.ts');
    expect(recovered.calls.filter((call) => call.url.includes('getstream'))).toHaveLength(2);

    const expired = makeRouter({ cdnStatuses: [403, 403] });
    const failing = makeEngine(expired, nowRef);
    await expect(failing.fetchPlaylist(channel)).rejects.toThrow('upstream m3u8 http 403');
    nowRef.t += 5_000;
    await expect(failing.fetchPlaylist(channel)).rejects.toThrow('cooldown');
    expect(expired.calls.filter((call) => call.url === CDN_URL)).toHaveLength(2);
  });

  it('writes a promoted standby identity onto the slot key', async () => {
    const nowRef = { t: 1_700_000_000_000 };
    const router = makeRouter();
    const storage = makeStorage();
    const engine = new IptvDeviceEngine({
      fetchImpl: router.fetchImpl,
      now: () => nowRef.t,
      randomBytes: fixedBytes,
      storage,
      sleep: () => Promise.resolve(),
      storageKey: 'tjxy-iptv-v9-standby',
    });
    await engine.fetchPlaylist(channel);
    engine.bindStorageKey('tjxy-iptv-v9-slot-0');
    expect(storage.map.has('tjxy-iptv-v9-slot-0')).toBe(true);
    expect(storage.map.get('tjxy-iptv-v9-slot-0')).toBe(storage.map.get('tjxy-iptv-v9-standby'));
  });
});

describe('iptvDevice helpers', () => {
  it('rewrites relative playlist urls against the final url', () => {
    const out = rewritePlaylistUrls('#EXTM3U\nseg.ts\nhttp://abs/x.ts\n#C\n', 'http://cdn.example/a/b/index.m3u8');
    expect(out).toBe('#EXTM3U\nhttp://cdn.example/a/b/seg.ts\nhttp://abs/x.ts\n#C\n');
    expect(rewritePlaylistUrls('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"', 'https://cdn.example/a/live.m3u8'))
      .toBe('#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/a/key.bin"\n#EXT-X-MAP:URI="https://cdn.example/a/init.mp4"');
  });

  it('flags the live CDN hosts that require signed headers', () => {
    expect(livePlaybackHostNeedsSignedHeaders('liveali.cctv.cn')).toBe(true);
    expect(livePlaybackHostNeedsSignedHeaders('LIVETEN.cctv.cn')).toBe(true);
    expect(livePlaybackHostNeedsSignedHeaders('cdn.example')).toBe(false);
  });
});
