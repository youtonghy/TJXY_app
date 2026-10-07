import { Alert, Button, Chip, Spinner } from '@heroui/react';
import { ArrowLeft, ChevronLeft, ChevronRight, History, ListVideo, Pause, Play, RotateCcw, Tv } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslate } from '../../settings/i18n';
import { WebPlayerSurface } from '../playback/WebPlayerSurface';
import { isIptvSupportedShell } from './iptvApi';
import { getIptvChannel, IPTV_CHANNELS, IPTV_LOGO_BASE, iptvChannelGroup, type IptvChannel } from './iptvChannels';
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
  const tvMode = typeof window !== 'undefined' && Boolean((window as Window & { __TJXY_TV_MODE__?: boolean }).__TJXY_TV_MODE__);
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

  if (tvMode) {
    return <TvFullscreen channel={channel} nowPlaying={nowPlaying} replay={replay} state={state} videoRef={videoRef} onReplay={(target) => setReplayTarget(target && { ...target, slug: channel.slug })} onRetry={() => { setState('ready'); setReloadKey((key) => key + 1); }} />;
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

function TvFullscreen({ channel, nowPlaying, replay, state, videoRef, onReplay, onRetry }: {
  channel: IptvChannel; nowPlaying?: string; replay: (ReplayTarget & { slug: string }) | null;
  state: PlayerState; videoRef: RefObject<HTMLVideoElement | null>; onReplay: (target: ReplayTarget | null) => void; onRetry: () => void;
}) {
  const tr = useTranslate();
  const navigate = useNavigate();
  const surface = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState<'channels' | 'guide' | null>(null);
  const [group, setGroup] = useState(iptvChannelGroup(channel.slug));
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [activity, setActivity] = useState(0);
  const showControls = () => { setControls(true); setActivity((value) => value + 1); };
  const index = IPTV_CHANNELS.findIndex((item) => item.slug === channel.slug);
  useEffect(() => {
    setBuffering(true);
    setPaused(false);
    showControls();
  }, [channel.slug]);
  useEffect(() => {
    if (!controls || panel || paused || state === 'failed') return;
    timer.current = setTimeout(() => { setControls(false); surface.current?.focus(); }, 5000);
    return () => clearTimeout(timer.current);
  }, [controls, activity, panel, paused, state]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    surface.current?.focus();
    return () => { document.body.style.overflow = previous; };
  }, []);
  useEffect(() => {
    if (panel) surface.current?.querySelector<HTMLElement>('[role="dialog"] button[aria-current="true"], [role="dialog"] button')?.focus();
  }, [panel, group]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'BrowserBack') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (panel) { setPanel(null); showControls(); surface.current?.focus(); }
        else if (controls) { setControls(false); surface.current?.focus(); }
        else navigate('/app/iptv');
        return;
      }
      if (panel) { showControls(); return; }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'MediaPlayPause'].includes(event.key)) return;
      if (controls && document.activeElement !== surface.current && event.key !== 'MediaPlayPause') { showControls(); return; }
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const next = IPTV_CHANNELS[(index + (event.key === 'ArrowRight' ? 1 : -1) + IPTV_CHANNELS.length) % IPTV_CHANNELS.length];
        if (next) navigate(`/app/iptv/${next.slug}`, { replace: true });
      } else if (event.key === 'ArrowUp') setPanel('channels');
      else if (event.key === 'ArrowDown') { showControls(); surface.current?.querySelector<HTMLButtonElement>('[data-tv-play]')?.focus(); }
      else if (event.key === 'MediaPlayPause' || controls) {
        const video = videoRef.current;
        if (video?.paused) void video.play().catch(() => undefined); else video?.pause();
        showControls();
      } else showControls();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [panel, controls, index, navigate, videoRef]);
  const changeChannel = (offset: number) => {
    const next = IPTV_CHANNELS[(index + offset + IPTV_CHANNELS.length) % IPTV_CHANNELS.length];
    if (next) navigate(`/app/iptv/${next.slug}`, { replace: true });
  };
  return createPortal(
    <div ref={surface} data-tv-iptv="true" className="tv-iptv" onPointerMove={showControls} onClick={showControls} aria-label={channel.name} tabIndex={-1}>
      <style>{TV_IPTV_CSS}</style>
      {state === 'ready' && <video ref={videoRef} className="tv-iptv-video" autoPlay playsInline disablePictureInPicture onWaiting={() => setBuffering(true)} onPlaying={() => { setBuffering(false); setPaused(false); }} onCanPlay={() => setBuffering(false)} onPause={() => setPaused(true)} aria-label={channel.name} />}
      {(buffering || state === 'failed') && (
          <div className="tv-iptv-status" role="status">{state === 'failed' ? <><Tv size={40} /><p>{tr('Channel unavailable', '频道暂时无法播放')}</p><Button onPress={onRetry}><RotateCcw size={18} />{tr('Retry', '重试')}</Button></> : <Spinner aria-label={tr('Loading live stream', '正在加载直播')} />}</div>
        )}
      <div className="tv-iptv-top" hidden={!controls && !panel}>
        <button aria-label={tr('Exit live TV', '退出直播')} title={tr('Exit live TV', '退出直播')} onClick={() => navigate('/app/iptv')}><ArrowLeft /></button>
        <img alt="" src={`${IPTV_LOGO_BASE}/${channel.slug}.png`} onError={(event) => { event.currentTarget.style.visibility = 'hidden'; }} />
        <span className="tv-iptv-brand">TJXY <span>LIVE TV</span></span>
        <span className="tv-iptv-quality">{channel.defn.toUpperCase()}</span>
      </div>
      <div className="tv-iptv-bottom" hidden={!controls || Boolean(panel)}>
        <div className="tv-iptv-caption"><span className="tv-iptv-live">{replay ? tr('REPLAY', '回看') : tr('LIVE', '直播')}</span><span>{String(index + 1).padStart(2, '0')}</span></div>
        <h1>{channel.name}</h1><p>{replay?.programme.title ?? nowPlaying ?? tr('Live television', '现场直播')}</p>
        <div className="tv-iptv-toolbar">
          <button aria-label={tr('Previous channel', '上一频道')} title={tr('Previous channel', '上一频道')} onClick={() => changeChannel(-1)}><ChevronLeft /></button>
          <button data-tv-play aria-label={paused ? tr('Play', '播放') : tr('Pause', '暂停')} title={paused ? tr('Play', '播放') : tr('Pause', '暂停')} onClick={() => { const video = videoRef.current; if (video?.paused) void video.play().catch(() => undefined); else video?.pause(); }}>{paused ? <Play /> : <Pause />}</button>
          <button aria-label={tr('Next channel', '下一频道')} title={tr('Next channel', '下一频道')} onClick={() => changeChannel(1)}><ChevronRight /></button>
          <button onClick={() => setPanel('channels')}><Tv />{tr('Channels', '频道')}</button>
          <button onClick={() => setPanel('guide')}><ListVideo />{tr('Programme guide', '节目单')}</button>
          {replay && <button onClick={() => onReplay(null)}><RotateCcw />{tr('Back to live', '返回直播')}</button>}
        </div>
      </div>
      {panel && <aside className="tv-iptv-panel" role="dialog" aria-modal="true" aria-label={panel === 'channels' ? tr('Channels', '频道') : tr('Programme guide', '节目单')}>
        <header><h2>{panel === 'channels' ? tr('Channels', '频道') : channel.name}</h2><button aria-label={tr('Close', '关闭')} onClick={() => { setPanel(null); surface.current?.focus(); }}><ArrowLeft /></button></header>
        {panel === 'channels' ? <><div className="tv-iptv-groups">{['央视频道', '卫视频道'].map((value) => <button key={value} aria-pressed={group === value} onClick={() => setGroup(value)}>{value === '央视频道' ? tr('CCTV', '央视') : tr('Satellite', '卫视')}</button>)}</div><div className="tv-iptv-list">{IPTV_CHANNELS.filter((item) => iptvChannelGroup(item.slug) === group).map((item) => <button key={item.slug} aria-current={item.slug === channel.slug} onClick={() => { navigate(`/app/iptv/${item.slug}`, { replace: true }); setPanel(null); surface.current?.focus(); }}><span>{String(IPTV_CHANNELS.indexOf(item) + 1).padStart(2, '0')}</span><span>{item.name}</span>{item.slug === channel.slug && <span className="tv-iptv-live">LIVE</span>}</button>)}</div></> : <div className="tv-iptv-guide"><ProgrammeGuide channel={channel} replay={replay} onReplay={(target) => { onReplay(target); setPanel(null); surface.current?.focus(); }} /></div>}
      </aside>}
    </div>, document.body,
  );
}

const TV_IPTV_CSS = `
.tv-iptv{position:fixed;inset:0;z-index:10000;background:#000;color:#fff;isolation:isolate;font-size:16px;outline:none!important;box-shadow:none!important}
.tv-iptv-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.tv-iptv [hidden]{display:none!important}.tv-iptv button{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:44px;padding:10px 14px;border-radius:6px;background:#ffffff16;color:#fff;flex-shrink:0}
.tv-iptv button:focus-visible{outline:3px solid #51d4ba!important;outline-offset:3px!important;box-shadow:none!important;background:#ffffff30}
.tv-iptv button svg{width:22px;height:22px}.tv-iptv-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:16px;padding:28px 38px 65px;background:linear-gradient(#000b,transparent)}
.tv-iptv-top img{width:46px;height:46px;object-fit:contain;background:#ffffffd9;border-radius:6px;padding:3px}.tv-iptv-brand{font-weight:600;font-size:20px}.tv-iptv-brand span{font-size:12px;color:#ffffff80;margin-left:10px}.tv-iptv-quality{margin-left:auto;font-size:13px;color:#ffffffa6;border:1px solid #ffffff40;border-radius:4px;padding:3px 8px}
.tv-iptv-bottom{position:absolute;bottom:0;left:0;right:0;padding:70px 38px 28px;background:linear-gradient(transparent,#000c 45%,#000e)}
.tv-iptv-caption{display:flex;align-items:center;gap:12px;font-size:13px;color:#ffffff85}.tv-iptv-live{color:#69e1bd!important;font-size:11px;font-weight:700}.tv-iptv-bottom h1{font-size:28px;line-height:36px;margin-top:9px}.tv-iptv-bottom p{font-size:16px;color:#ffffffab;margin:4px 0 18px}.tv-iptv-toolbar{display:flex;gap:10px;align-items:center}
.tv-iptv-status{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}.tv-iptv-panel{position:absolute;right:0;top:0;bottom:0;width:420px;max-width:70%;background:#111816f5;border-left:1px solid #ffffff20;display:flex;flex-direction:column;padding:28px 26px;box-shadow:-30px 0 80px #0005}
.tv-iptv-panel header{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:20px}.tv-iptv-panel h2{font-size:22px;font-weight:600}.tv-iptv-groups{display:flex;gap:10px;margin-bottom:16px}.tv-iptv-groups button{flex:1}.tv-iptv button[aria-pressed=true]{background:#66dfbc;color:#10201b}.tv-iptv-list,.tv-iptv-guide{overflow-y:auto;min-height:0;flex:1;padding:5px}
.tv-iptv-list button{width:100%;justify-content:flex-start;margin-bottom:6px;min-height:50px;text-align:left}.tv-iptv-list button>span:first-child{color:#ffffff65;font-size:12px;width:24px}.tv-iptv-list button>span:nth-child(2){flex:1;min-width:0;overflow-wrap:anywhere}.tv-iptv-list button[aria-current=true]{background:#66dfbc20;border-left:3px solid #66dfbc}.tv-iptv-guide{--color-foreground:#fff;--color-muted:#9cafaa;--color-surface:#16231e;--color-surface-secondary:#203229}
@media(prefers-reduced-motion:reduce){.tv-iptv *{transition:none!important}}
`;

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
