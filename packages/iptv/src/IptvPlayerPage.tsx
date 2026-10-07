import { Alert, Button, Chip, Spinner } from '@heroui/react';
import { ArrowLeft, History, Play, RotateCcw, Tv } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslate } from '../../settings/i18n';
import { WebPlayerSurface } from '../playback/WebPlayerSurface';
import { isIptvSupportedShell } from './iptvApi';
import { getIptvChannel, IPTV_LOGO_BASE, iptvChannelGroup, type IptvChannel } from './iptvChannels';
import { loadIptvGuide, loadIptvProgrammes, type IptvProgramme } from './iptvEpg';
import { attachIptvLive, attachIptvReplay, isIptvJceChannel } from './iptvLive';

interface ReplayTarget {
  programme: IptvProgramme;
}

type PlayerState = 'loading' | 'ready' | 'failed' | 'unsupported';
type FailureKind = 'resolve' | 'playback';

export function IptvPlayerPage() {
  const tr = useTranslate();
  const { slug = '' } = useParams();
  const channel = getIptvChannel(slug);
  const supported = isIptvSupportedShell();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failure, setFailure] = useState<FailureKind>('resolve');
  const [reloadKey, setReloadKey] = useState(0);
  const [nowPlaying, setNowPlaying] = useState<string>();
  const [replayTarget, setReplayTarget] = useState<(ReplayTarget & { slug: string }) | null>(null);
  const replay = replayTarget?.slug === channel?.slug ? replayTarget : null;
  const [state, setState] = useState<PlayerState>(() =>
    channel && supported ? 'ready' : 'loading',
  );

  useEffect(() => {
    if (!channel || !supported) return;
    setState('ready');
  }, [channel, supported, reloadKey]);

  useEffect(() => {
    if (!channel?.tvgId || !supported) return;
    let active = true;
    void loadIptvGuide().then((guide) => {
      if (active) setNowPlaying(guide.get(channel.tvgId ?? '')?.title);
    });
    return () => { active = false; };
  }, [channel, supported]);

  // Every channel uses the same client resolution chain, including non-JCE channels.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !channel || state !== 'ready') return;
    let disposed = false;
    let detach: (() => void) | undefined;
    const fail = () => {
      if (!disposed) { setFailure('playback'); setState('failed'); }
    };
    if (replay) {
      // Upstream degrades a failed catchup request to the live stream instead
      // of erroring; dropping the replay target re-attaches the live session.
      const degrade = () => {
        if (!disposed) setReplayTarget(null);
      };
      void attachIptvReplay(video, channel, replay.programme, degrade).then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        detach = cleanup;
      }, degrade);
    } else {
      void attachIptvLive(video, channel, fail).then((cleanup) => {
        if (disposed) {
          cleanup?.();
          return;
        }
        if (cleanup) {
          detach = cleanup;
        } else {
          fail();
        }
      }, fail);
    }
    return () => {
      disposed = true;
      detach?.();
    };
  }, [channel, state, replay, reloadKey]);

  if (!channel) {
    return (
      <Alert role="alert" status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{tr('Unknown channel', '未知频道')}</Alert.Title>
          <Alert.Description>
            <Link className="text-accent hover:underline" to="/app/iptv">
              {tr('Back to the channel list.', '返回频道列表。')}
            </Link>
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  if (!supported) {
    return <UnsupportedNotice channel={channel} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          aria-label={tr('Back to channels', '返回频道列表')}
          className="inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-secondary hover:text-foreground"
          to="/app/iptv"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <ChannelHeading channel={channel} />
      </div>

      <div className="overflow-hidden rounded-xl border border-default/20 bg-black">
        {state === 'ready' ? (
          <WebPlayerSurface
            onCanPlay={() => undefined}
            onEnded={() => undefined}
            onError={() => undefined}
            onLoadedMetadata={() => undefined}
            onPause={() => undefined}
            onPlay={() => undefined}
            onTimeUpdate={() => undefined}
            subtitles={null}
            title={channel.name}
            videoRef={videoRef}
          />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center">
            {state === 'loading' ? (
              <Spinner aria-label={tr('Resolving stream', '正在解析直播地址')} color="accent" />
            ) : (
              <div className="flex flex-col items-center gap-3 p-6 text-center">
                <Tv aria-hidden="true" className="size-8 text-muted" />
                <p className="text-sm text-muted">
                  {tr('This channel is not available right now.', '该频道暂时无法播放。')}
                </p>
                <Button
                  onPress={() => {
                    setState('ready');
                    setReloadKey((key) => key + 1);
                  }}
                  size="sm"
                  variant="secondary"
                >
                  <RotateCcw aria-hidden="true" className="size-4" />
                  {tr('Retry', '重试')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {state === 'failed' && (
        <Alert role="alert" status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {failure === 'resolve'
                ? tr('Unable to resolve the live stream', '无法解析直播地址')
                : tr('The resolved streams could not be played', '直播地址解析成功，但所有流均无法播放')}
            </Alert.Title>
            <Alert.Description>
              {failure === 'resolve'
                ? tr('The upstream source may be temporarily unavailable. Try again later.', '上游直播源可能暂时不可用，请稍后重试。')
                : tr('The stream CDN may be unreachable from this network. Try another channel or network.', '当前网络可能无法访问该直播 CDN，请更换频道或网络后重试。')}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {replay && (
        <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-surface px-4 py-3">
          <History aria-hidden="true" className="size-4 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{replay.programme.title}</p>
            <p className="text-xs text-muted">
              {formatTime(replay.programme.start)} – {formatTime(replay.programme.stop)}
            </p>
          </div>
          <Button
            onPress={() => { setReplayTarget(null); }}
            size="sm"
            variant="secondary"
          >
            {tr('Back to live', '返回直播')}
          </Button>
        </div>
      )}

      <ChannelMeta channel={channel} nowPlaying={nowPlaying} />

      <ProgrammeGuide
        channel={channel}
        onReplay={(target) => { setReplayTarget(target && { ...target, slug: channel.slug }); }}
        replay={replay}
      />
    </div>
  );
}

function ChannelHeading({ channel }: { channel: IptvChannel }) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-secondary">
        {logoFailed ? (
          <Tv aria-hidden="true" className="size-5 text-muted" />
        ) : (
          <img
            alt=""
            className="size-10 object-contain"
            onError={() => { setLogoFailed(true); }}
            src={`${IPTV_LOGO_BASE}/${channel.slug}.png`}
          />
        )}
      </div>
      <h1 className="truncate text-xl font-semibold text-foreground">{channel.name}</h1>
    </div>
  );
}

function ChannelMeta({ channel, nowPlaying }: { channel: IptvChannel; nowPlaying?: string }) {
  const tr = useTranslate();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip size="sm" variant="secondary">{iptvChannelGroup(channel.slug)}</Chip>
        <Chip size="sm" variant="secondary">{channel.defn.toUpperCase()}</Chip>
        {channel.timeshift && (
          <Chip size="sm" variant="soft">
            <History aria-hidden="true" className="size-3" />
            {tr('7-day replay', '7 天回看')}
          </Chip>
        )}
      </div>
      {nowPlaying && (
        <p className="text-sm text-muted">
          {tr('Now playing:', '正在播放：')}{nowPlaying}
        </p>
      )}
    </div>
  );
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function localDayStart(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayLabel(start: number, todayStart: number, tr: (en: string, zh: string) => string): string {
  const day = new Date(start);
  day.setHours(0, 0, 0, 0);
  const offset = Math.round((day.getTime() - todayStart) / 86_400_000);
  if (offset === -1) return tr('Yesterday', '昨天');
  if (offset === 0) return tr('Today', '今天');
  if (offset === 1) return tr('Tomorrow', '明天');
  const date = new Date(start);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ProgrammeGuide({
  channel,
  onReplay,
  replay,
}: {
  channel: IptvChannel;
  onReplay: (target: ReplayTarget | null) => void;
  replay: ReplayTarget | null;
}) {
  const tr = useTranslate();
  const [loaded, setLoaded] = useState<{ at: number; programmes: IptvProgramme[] }>();
  useEffect(() => {
    const tvgId = channel.tvgId;
    if (!tvgId) return;
    let active = true;
    void loadIptvProgrammes().then((schedules) => {
      if (active) setLoaded({ at: Date.now(), programmes: schedules.get(tvgId) ?? [] });
    });
    return () => { active = false; };
  }, [channel.tvgId]);

  if (!channel.tvgId || !loaded?.programmes.length) return null;
  const now = loaded.at;
  const todayStart = localDayStart(now);
  const visible = loaded.programmes.filter((programme) => programme.stop > now - 7 * 86_400_000);
  if (!visible.length) return null;
  const canReplay = isIptvJceChannel(channel);
  const replayStart = replay?.programme.start;

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <History aria-hidden="true" className="size-4 text-muted" />
        {tr('Programme guide', '节目单')}
      </h2>
      <div className="overflow-hidden rounded-xl border border-default/20">
        {visible.map((programme, index) => {
          const airing = now >= programme.start && now < programme.stop;
          const ended = programme.stop <= now;
          const active = replayStart === programme.start;
          const replayable = ended && canReplay && programme.start >= now - 7 * 86_400_000;
          const clickable = airing || replayable;
          const label = dayLabel(programme.start, todayStart, tr);
          const previous = visible[index - 1];
          const divider =
            !previous || dayLabel(previous.start, todayStart, tr) !== label ? label : undefined;
          const row = (
            <button
              className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                active
                  ? 'bg-accent/10'
                  : replayable
                    ? 'hover:bg-surface-secondary'
                    : 'cursor-default'
              }`}
              disabled={!clickable}
              key={programme.start}
              onClick={() => {
                if (airing) onReplay(null);
                else if (replayable) onReplay({ programme });
              }}
              type="button"
            >
              <span className="w-11 shrink-0 font-mono text-xs text-muted">{formatTime(programme.start)}</span>
              <span className={`min-w-0 flex-1 truncate text-sm ${ended || airing ? 'text-foreground' : 'text-muted'}`}>
                {programme.title}
              </span>
              {active && <Chip size="sm" variant="soft">{tr('Replaying', '回放中')}</Chip>}
              {airing && !active && <Chip size="sm" variant="soft">{tr('Live', '直播')}</Chip>}
              {replayable && !active && (
                <Play aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
              )}
            </button>
          );
          return (
            <div className="border-t border-default/20 first:border-t-0" key={programme.start}>
              {divider && (
                <p className="bg-surface-secondary px-4 py-1 text-xs font-medium text-muted">{divider}</p>
              )}
              {row}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function UnsupportedNotice({ channel }: { channel: IptvChannel }) {
  const tr = useTranslate();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          aria-label={tr('Back to channels', '返回频道列表')}
          className="inline-flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-secondary hover:text-foreground"
          to="/app/iptv"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <ChannelHeading channel={channel} />
      </div>
      <Alert role="alert" status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{tr('IPTV needs the app', 'IPTV 需要应用环境')}</Alert.Title>
          <Alert.Description>
            {tr(
              'Channel resolution is unavailable in a plain browser. Open this page in the mobile or desktop app.',
              '浏览器环境无法解析频道地址，请在移动端或桌面端应用中打开此页面。',
            )}
          </Alert.Description>
        </Alert.Content>
      </Alert>
    </div>
  );
}
