import { clientRequest, type ClientSession } from './http.ts';

export interface PlaybackSource {
  Id: string;
  Name?: string;
  Container?: string;
  Bitrate?: number;
  RunTimeTicks?: number;
  IsDefault?: boolean;
  IsLive?: boolean;
  SupportsDirectPlay?: boolean;
  SupportsDirectStream?: boolean;
  SupportsTranscoding?: boolean;
  DirectStreamUrl?: string;
  RequiredHttpHeaders?: Record<string, string>;
  MediaStreams?: PlaybackStream[];
}

export interface PlaybackStream {
  Type?: 'Audio' | 'Video' | 'Subtitle';
  Codec?: string;
  Language?: string;
  Width?: number;
  Height?: number;
  Channels?: number;
  DeliveryUrl?: string;
  IsExternal?: boolean;
  IsDefault?: boolean;
  IsForced?: boolean;
  Index?: number;
}

export interface PlaybackInfo {
  MediaSources?: PlaybackSource[];
  PlaySessionId?: string;
}

export interface PlaybackTicket {
  Id: string;
  Ticket: string;
  ExpiresAt: string;
  StreamUrl: string;
}

export interface PlaybackState {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  positionTicks: number;
}

export async function getPlaybackInfo(session: ClientSession, itemId: string): Promise<PlaybackInfo> {
  return clientRequest<PlaybackInfo>(session, `/Items/${itemId}/PlaybackInfo`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function issuePlaybackTicket(
  session: ClientSession,
  itemId: string,
  mediaSourceId: string,
  playSessionId: string,
): Promise<PlaybackTicket> {
  return clientRequest<PlaybackTicket>(session, `/Items/${itemId}/PlaybackTicket`, {
    method: 'POST',
    body: JSON.stringify({ MediaSourceId: mediaSourceId, PlaySessionId: playSessionId }),
  });
}

export async function revokePlaybackTicket(session: ClientSession, id: string): Promise<void> {
  await clientRequest(session, `/PlaybackTickets/${id}`, { method: 'DELETE' });
}

export async function startPlayback(session: ClientSession, state: PlaybackState): Promise<void> {
  await sendPlaybackState(session, '/Sessions/Playing', state);
}

export async function reportPlaybackProgress(session: ClientSession, state: PlaybackState): Promise<void> {
  await sendPlaybackState(session, '/Sessions/Playing/Progress', state);
}

export async function stopPlayback(session: ClientSession, state: PlaybackState): Promise<void> {
  await sendPlaybackState(session, '/Sessions/Playing/Stopped', state);
}

const BROWSER_CONTAINERS = new Set(['mp4', 'm4v', 'webm', 'mp3', 'm4a', 'ogg']);

export function nativeSources(sources: PlaybackSource[]): PlaybackSource[] {
  const withId = sources.filter((source) => (
    Boolean(source.Id) && Boolean(source.DirectStreamUrl) && source.IsLive !== true
  ));
  const direct = withId.filter((source) => source.SupportsDirectPlay !== false && source.IsLive !== true);
  const pool = direct.length > 0 ? direct : withId;
  const preferred = pool.filter((source) => BROWSER_CONTAINERS.has((source.Container ?? '').toLowerCase()));
  preferred.sort((left, right) => Number(right.IsDefault === true) - Number(left.IsDefault === true));
  if (preferred.length === 0) return pool;
  const rest = pool.filter((source) => !preferred.includes(source));
  return [...preferred, ...rest];
}

export function selectNativeSource(sources: PlaybackSource[]): PlaybackSource | undefined {
  return nativeSources(sources)[0];
}

async function sendPlaybackState(session: ClientSession, path: string, state: PlaybackState): Promise<void> {
  await clientRequest(session, path, {
    method: 'POST',
    body: JSON.stringify({
      ItemId: state.itemId,
      MediaSourceId: state.mediaSourceId,
      PlaySessionId: state.playSessionId,
      PositionTicks: state.positionTicks,
    }),
  });
}
