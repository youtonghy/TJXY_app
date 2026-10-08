import { describe, expect, it, vi } from 'vitest';
import { getIptvChannel, IPTV_CHANNELS, iptvChannelGroup } from './iptvChannels';
import { IptvDevicePool } from './iptvDevicePool';

function createPool() {
  const engines: Array<{
    fetchPlaylist: ReturnType<typeof vi.fn>;
    prewarm: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    bindStorageKey: ReturnType<typeof vi.fn>;
  }> = [];
  const pool = new IptvDevicePool(() => {
    const engine = {
      fetchPlaylist: vi.fn(async () => '#EXTM3U\nhttps://cdn.example/a.ts\n'),
      segmentHeaders: () => ({ UID: String(engines.length) }),
      prewarm: vi.fn(),
      dispose: vi.fn(),
      bindStorageKey: vi.fn(),
    };
    engines.push(engine);
    return engine;
  });
  return { engines, pool };
}

describe('v9 client device pool', () => {
  it('keeps UHD separate and retries a limited device using the standby', async () => {
    const { engines, pool } = createPool();
    engines[1]!.fetchPlaylist.mockRejectedValueOnce(new Error('live/v1/01 http 400'));
    await pool.fetchPlaylist(IPTV_CHANNELS[0]!);
    expect(engines[1]!.dispose).toHaveBeenCalledOnce();
    expect(engines[1]!.bindStorageKey).not.toHaveBeenCalled();
    expect(engines[3]!.fetchPlaylist).toHaveBeenCalledOnce();
    expect(engines[3]!.bindStorageKey).toHaveBeenCalledWith('tjxy-iptv-v9-slot-1');
    expect(engines[4]!.prewarm).toHaveBeenCalledOnce();
    await pool.fetchPlaylist(IPTV_CHANNELS.find((channel) => channel.slug === 'cctv4k')!);
    expect(engines[0]!.fetchPlaylist).toHaveBeenCalledOnce();
    pool.dispose();
  });

  it('moves a new high-bitrate channel to the other slot before rotating, and never quota-rotates UHD', async () => {
    const { engines, pool } = createPool();
    const ordinary = IPTV_CHANNELS.filter((channel) => !['cctv4k', 'cctv8k', 'cctv164k'].includes(channel.slug));
    for (const channel of ordinary.slice(0, 12)) await pool.fetchPlaylist(channel);
    expect(engines[0]!.dispose).not.toHaveBeenCalled();
    expect(engines[1]!.dispose).not.toHaveBeenCalled();
    expect(engines[2]!.dispose).not.toHaveBeenCalled();
    await pool.fetchPlaylist(ordinary[12]!);
    expect(engines[1]!.dispose).toHaveBeenCalledOnce();
    expect(engines[0]!.dispose).not.toHaveBeenCalled();
    expect(engines[2]!.dispose).not.toHaveBeenCalled();
    pool.dispose();
  });

  it('retries a 4K CDN expiry on the hot standby and lets other channels degrade', async () => {
    const uhd = createPool();
    uhd.engines[0]!.fetchPlaylist.mockRejectedValueOnce(new Error('upstream m3u8 http 403'));
    await uhd.pool.fetchPlaylist(IPTV_CHANNELS.find((channel) => channel.slug === 'cctv4k')!);
    expect(uhd.engines[0]!.dispose).toHaveBeenCalledOnce();
    expect(uhd.engines[3]!.fetchPlaylist).toHaveBeenCalledOnce();
    uhd.pool.dispose();

    const ordinary = createPool();
    ordinary.engines[1]!.fetchPlaylist.mockRejectedValueOnce(new Error('upstream m3u8 http 403'));
    await expect(ordinary.pool.fetchPlaylist(IPTV_CHANNELS[0]!)).rejects.toThrow('upstream m3u8 http 403');
    expect(ordinary.engines[1]!.dispose).not.toHaveBeenCalled();
    ordinary.pool.dispose();
  });
});

describe('iptv channel aliases', () => {
  it('resolves upstream aliases and strips a playlist suffix', () => {
    expect(getIptvChannel('anhuiws')?.slug).toBe('ahws');
    expect(getIptvChannel('/CCTV5PLUS.m3u8')?.slug).toBe('cctv5p');
    expect(iptvChannelGroup('dongfangws')).toBe('卫视频道');
    expect(iptvChannelGroup('cgtnfayu')).toBe('央视频道');
    expect(getIptvChannel('not-a-channel')).toBeUndefined();
  });
});
