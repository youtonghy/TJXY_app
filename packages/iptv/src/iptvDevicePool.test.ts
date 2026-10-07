import { describe, expect, it, vi } from 'vitest';
import { IptvDevicePool } from './iptvDevicePool';
import { IPTV_CHANNELS } from './iptvChannels';

describe('v9 client device pool', () => {
  it('keeps UHD separate and retries a limited device using the standby', async () => {
    const engines: Array<{ fetchPlaylist: ReturnType<typeof vi.fn>; prewarm: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
    const pool = new IptvDevicePool(() => {
      const engine = {
        fetchPlaylist: vi.fn(async () => '#EXTM3U\nhttps://cdn.example/a.ts\n'),
        segmentHeaders: () => ({ UID: String(engines.length) }), prewarm: vi.fn(), dispose: vi.fn(),
      };
      engines.push(engine);
      return engine;
    });
    engines[1]!.fetchPlaylist.mockRejectedValueOnce(new Error('live/v1/01 http 400'));
    await pool.fetchPlaylist(IPTV_CHANNELS[0]!);
    expect(engines[1]!.dispose).toHaveBeenCalledOnce();
    expect(engines[3]!.fetchPlaylist).toHaveBeenCalledOnce();
    expect(engines[4]!.prewarm).toHaveBeenCalledOnce();
    await pool.fetchPlaylist(IPTV_CHANNELS.find((channel) => channel.slug === 'cctv4k')!);
    expect(engines[0]!.fetchPlaylist).toHaveBeenCalledOnce();
    pool.dispose();
  });
});
