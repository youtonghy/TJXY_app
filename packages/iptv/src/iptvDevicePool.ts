import type { IptvChannel } from './iptvChannels';
import { IptvDeviceEngine, isSessionInvalidatingError, isUpstreamPlaylistExpiry } from './iptvDevice';

type Engine = Pick<IptvDeviceEngine, 'fetchPlaylist' | 'segmentHeaders' | 'prewarm' | 'dispose' | 'bindStorageKey'>;
const UHD_CHANNELS = new Set(['cctv4k', 'cctv8k', 'cctv164k']);
const LINKS_PER_DEVICE = 6;
const ROTATE_COOLDOWN_MS = 8_000;

export class IptvDevicePool {
  private readonly slots: Engine[];
  private readonly linked = [new Set<string>(), new Set<string>(), new Set<string>()];
  private readonly lastRotateAt = [0, 0, 0];
  private standby: Engine;
  private sequence = 0;
  private readonly headers = new Map<string, Record<string, string>>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(private readonly create: (key: string) => Engine = (key) => new IptvDeviceEngine({
    storageKey: key,
  })) {
    this.slots = [0, 1, 2].map((slot) => this.create(`tjxy-iptv-v9-slot-${slot}`));
    this.standby = this.create('tjxy-iptv-v9-standby');
  }

  prewarm(): void {
    this.slots[0]?.prewarm();
    this.standby.prewarm();
  }

  fetchPlaylist(channel: IptvChannel): Promise<string> {
    let pending = this.pending.get(channel.slug);
    if (!pending) {
      pending = this.fetchOnce(channel).finally(() => this.pending.delete(channel.slug));
      this.pending.set(channel.slug, pending);
    }
    return pending;
  }

  segmentHeaders(url: string): Record<string, string> {
    return this.headers.get(url) ?? this.slots[0]!.segmentHeaders(url);
  }

  dispose(): void {
    for (const engine of [...this.slots, this.standby]) engine.dispose();
  }

  private async fetchOnce(channel: IptvChannel): Promise<string> {
    const slot = this.assignSlot(channel.slug);
    const linked = this.linked[slot]!;
    // Quota applies only to the two high-bitrate slots. UHD keeps its own
    // device; a full slot first tries the other one, and rotates only when
    // both are at the limit.
    if (slot !== 0 && !linked.has(channel.slug) && linked.size >= LINKS_PER_DEVICE) this.rotate(slot);
    let engine = this.slots[slot]!;
    let playlist: string;
    try {
      playlist = await engine.fetchPlaylist(channel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const swap = isSessionInvalidatingError(message) || (slot === 0 && isUpstreamPlaylistExpiry(message));
      if (!swap) throw error;
      // v9 retries the same channel with the hot standby before lowering quality.
      if (this.slots[slot] === engine) this.rotate(slot);
      engine = this.slots[slot]!;
      playlist = await engine.fetchPlaylist(channel);
    }
    this.linked[slot]!.add(channel.slug);
    for (const line of playlist.split('\n')) {
      const url = line.trim();
      if (url && !url.startsWith('#')) this.headers.set(url, engine.segmentHeaders(url));
    }
    while (this.headers.size > 2000) this.headers.delete(this.headers.keys().next().value!);
    return playlist;
  }

  private slotFor(slug: string): number {
    if (UHD_CHANNELS.has(slug)) return 0;
    for (const slot of [1, 2]) if (this.linked[slot]!.has(slug)) return slot;
    return this.linked[1]!.size <= this.linked[2]!.size ? 1 : 2;
  }

  private assignSlot(slug: string): number {
    const preferred = this.slotFor(slug);
    if (preferred === 0) return 0;
    const linked = this.linked[preferred]!;
    if (linked.has(slug) || linked.size < LINKS_PER_DEVICE) return preferred;
    const other = preferred === 1 ? 2 : 1;
    return this.linked[other]!.size < LINKS_PER_DEVICE ? other : preferred;
  }

  private rotate(slot: number): void {
    const now = Date.now();
    if (now - this.lastRotateAt[slot]! < ROTATE_COOLDOWN_MS) return;
    const slotKey = `tjxy-iptv-v9-slot-${String(slot)}`;
    this.slots[slot]?.dispose();
    this.slots[slot] = this.standby;
    this.slots[slot]?.bindStorageKey(slotKey);
    this.linked[slot]!.clear();
    this.lastRotateAt[slot] = now;
    this.standby = this.create(`tjxy-iptv-v9-reserve-${String(++this.sequence)}`);
    this.standby.prewarm();
  }
}

let shared: IptvDevicePool | undefined;
export function getIptvDeviceEngine(): IptvDevicePool {
  shared ??= new IptvDevicePool();
  return shared;
}
