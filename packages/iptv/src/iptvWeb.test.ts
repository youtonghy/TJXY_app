import { describe, expect, it, vi } from 'vitest';
import { aes128CbcEncryptHex } from './iptvDeviceCrypto';
import { buildCKey, buildTicket, runKeygen } from './iptvWebWasm.js';
import { resolveIptvWeb } from './iptvWeb';
import { IPTV_CHANNELS } from './iptvChannels';

describe('v9 client Web engine', () => {
  it('matches Node AES-CBC including PKCS7 padding', () => {
    const key = '48e5918a74ae21c972b90cce8af6c8be';
    const iv = '9a7e7d23610266b1d9fbf98581384d92';
    // Golden vectors generated with Node createCipheriv('aes-128-cbc').
    for (const [plain, expected] of [
      ['', 'd65e7e1a61359ad5790dc45ccd682c7b'],
      ['1234567890123456', '5c95898fc77fcb2260553e50a9c6ede1348e6beb601d435c7fd595fb4f829d92'],
      ['签名向量', 'd3dd3b6d82b17d79fc7561526e8c0552'],
    ] as const) {
      expect(aes128CbcEncryptHex(plain, key, iv)).toBe(expected);
    }
    expect(buildCKey('2024078201', 1791350000, 'test-guid')).toMatch(/^--01[0-9A-F]+$/);
  });

  it('executes both bundled WASM modules without Node APIs', () => {
    const keys = runKeygen({ guid: 'test-guid', yspappid: '519748109', version: 'v1', host: 'www.yangshipin.cn', protocol: 'https:', token: '', input: '', ts: '1791350000000' });
    expect(keys.getRnd().length).toBeGreaterThan(0);
    expect(buildTicket('600001859', '1791350000', '2024078201', 'test-guid')).toMatch(/^[0-9a-f]+$/);
  });

  it('signs the Web flow and returns direct client segment URLs', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/player/auth')) return Response.json({ data: { token: 'auth-token', ts: 1791350000 } });
      if (url.includes('/open/token')) return Response.json({ data: { token: 'open-token', ts: '1791350000000' } });
      if (url.includes('/get_live_info')) {
        expect(new Headers(init?.headers).get('yspticket')).toMatch(/^[0-9a-f]+$/);
        return Response.json({ data: { playurl: 'https://cdn.example/live/index.m3u8' } });
      }
      return new Response('#EXTM3U\n#EXTINF:6,\nseg.ts\n');
    });
    await expect(resolveIptvWeb(IPTV_CHANNELS[0]!, fetchImpl)).resolves.toContain('https://cdn.example/live/seg.ts');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
