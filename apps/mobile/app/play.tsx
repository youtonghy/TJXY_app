import Ionicons from '@expo/vector-icons/Ionicons';
import { useEventListener } from 'expo';
import { useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import { StatusBar } from 'expo-status-bar';
import {
  useVideoPlayer,
  VideoView,
  type AudioTrack,
  type SubtitleTrack,
  type VideoPlayerStatus,
} from 'expo-video';
import { Alert, Spinner, Typography } from 'heroui-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { BackHandler, ScrollView, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import {
  ClientApiError,
  getItem,
  getMe,
  getPlaybackInfo,
  issuePlaybackTicket,
  nativeSources,
  randomUuid,
  reportPlaybackProgress,
  revokePlaybackTicket,
  startPlayback,
  stopPlayback,
  togglePlayed,
  type ClientErrorKind,
  type ClientSession,
  type PlaybackSource,
  type PlaybackState,
} from '@tjxy/client-api';
import { buildClient } from '../src/bridgeSession';
import { postToWeb, takePendingPlayRequest, type NativePlayRequest } from '../src/playRequest';
import { TvButton as Button } from '../src/ui/TvButton';
import { TvPressable } from '../src/ui/TvPressable';

const TICKS_PER_SECOND = 10_000_000;
const SEEK_SECONDS = 10;
const PROGRESS_INTERVAL_MS = 15_000;
const CONTROLS_HIDE_MS = 4_000;
const THUMB_SIZE = 16;
const CLIENT_ERROR_MESSAGES: Partial<Record<ClientErrorKind, string>> = {
  authentication: '登录已失效，请重新登录',
  authorization: '没有权限访问此内容',
  network: '无法连接服务器',
  'not-found': '内容不存在或已被移除',
  'rate-limit': '请求过于频繁，请稍后再试',
};

type PickerKind = 'source' | 'audio' | 'subtitle';
type IconName = ComponentProps<typeof Ionicons>['name'];
type ReportFn = (session: ClientSession, state: PlaybackState) => Promise<void>;

interface ActivePlayback {
  mediaSourceId: string;
  playSessionId: string;
  ticketId: string;
}

interface PickerOption {
  key: string;
  label: string;
  selected: boolean;
}

export default function PlayScreen() {
  const router = useRouter();
  const [request] = useState<NativePlayRequest | undefined>(() => takePendingPlayRequest());
  const client = useMemo(() => (request ? buildClient(request.session) : null), [request]);
  const [title, setTitle] = useState('');
  const [sources, setSources] = useState<PlaybackSource[]>([]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [failure, setFailure] = useState<string | undefined>(request ? undefined : '没有待播放的内容');
  const [preparing, setPreparing] = useState(Boolean(request));
  const [status, setStatus] = useState<VideoPlayerStatus>('idle');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [audioTrack, setAudioTrack] = useState<AudioTrack | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrack[]>([]);
  const [subtitleTrack, setSubtitleTrack] = useState<SubtitleTrack | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [picker, setPicker] = useState<PickerKind>();
  const [scrubbing, setScrubbing] = useState(false);
  const [interaction, setInteraction] = useState(0);

  const titleRef = useRef('');
  const userIdRef = useRef<string | undefined>(undefined);
  const activeRef = useRef<ActivePlayback | undefined>(undefined);
  const startedRef = useRef(false);
  const positionRef = useRef(0);
  const pendingSeekRef = useRef<number | undefined>(undefined);
  const autoplayRef = useRef(false);
  const generationRef = useRef(0);

  const player = useVideoPlayer(null, (instance) => {
    instance.loop = false;
    instance.staysActiveInBackground = true;
    instance.timeUpdateEventInterval = 1;
  });

  const report = useCallback((send: ReportFn) => {
    const active = activeRef.current;
    if (!active || !client || !request) return;
    void send(client, {
      itemId: request.itemId,
      mediaSourceId: active.mediaSourceId,
      playSessionId: active.playSessionId,
      positionTicks: positionRef.current,
    }).catch(() => undefined);
  }, [client, request]);

  const releaseActive = useCallback(() => {
    const active = activeRef.current;
    if (!active || !client) return;
    if (startedRef.current) report(stopPlayback);
    startedRef.current = false;
    activeRef.current = undefined;
    void revokePlaybackTicket(client, active.ticketId).catch(() => undefined);
  }, [client, report]);

  const openSource = useCallback(async (
    list: PlaybackSource[],
    index: number,
    startTicks: number,
    playSessionId: string = randomUuid(),
  ) => {
    const source = list[index];
    if (!client || !request || !source) return;
    const generation = ++generationRef.current;
    releaseActive();
    player.pause();
    setFailure(undefined);
    setPreparing(true);
    setSourceIndex(index);
    positionRef.current = startTicks;
    try {
      const ticket = await issuePlaybackTicket(client, request.itemId, source.Id, playSessionId);
      if (generation !== generationRef.current) {
        void revokePlaybackTicket(client, ticket.Id).catch(() => undefined);
        return;
      }
      activeRef.current = { mediaSourceId: source.Id, playSessionId, ticketId: ticket.Id };
      pendingSeekRef.current = startTicks > 0 ? startTicks / TICKS_PER_SECOND : undefined;
      autoplayRef.current = true;
      const uri = resolveStreamUrl(ticket.StreamUrl, request.session.serverOrigin);
      await player.replaceAsync({
        uri,
        contentType: uri.includes('.m3u8') ? 'hls' : 'auto',
        metadata: { title: titleRef.current },
      });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setFailure(errorMessage(error, '无法打开视频源'));
    } finally {
      if (generation === generationRef.current) setPreparing(false);
    }
  }, [client, player, releaseActive, request]);

  const load = useCallback(async () => {
    if (!client || !request) return;
    const generation = ++generationRef.current;
    setFailure(undefined);
    setPreparing(true);
    try {
      const [item, info, me] = await Promise.all([
        getItem(client, request.itemId),
        getPlaybackInfo(client, request.itemId),
        getMe(client).catch(() => undefined),
      ]);
      if (generation !== generationRef.current) return;
      userIdRef.current = me?.Id;
      titleRef.current = item.Name;
      setTitle(item.Name);
      const candidates = preferDefault(nativeSources(info.MediaSources ?? []));
      setSources(candidates);
      if (candidates.length === 0) {
        setFailure('没有可在本机播放的视频源');
        setPreparing(false);
        return;
      }
      await openSource(candidates, 0, item.UserData?.PlaybackPositionTicks ?? 0, info.PlaySessionId || undefined);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setFailure(errorMessage(error, '加载播放信息失败'));
      setPreparing(false);
    }
  }, [client, openSource, request]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => undefined);
    return () => {
      generationRef.current += 1;
      releaseActive();
      void ScreenOrientation.unlockAsync().catch(() => undefined);
      postToWeb({ type: 'tjxy-playback-exit' });
    };
  }, [releaseActive]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (startedRef.current && player.playing) report(reportPlaybackProgress);
    }, PROGRESS_INTERVAL_MS);
    return () => { clearInterval(timer); };
  }, [player, report]);

  useEffect(() => {
    if (!controlsVisible || !isPlaying || picker || scrubbing) return;
    const timer = setTimeout(() => { setControlsVisible(false); }, CONTROLS_HIDE_MS);
    return () => { clearTimeout(timer); };
  }, [controlsVisible, interaction, isPlaying, picker, scrubbing]);

  useEffect(() => {
    if (!picker) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setPicker(undefined);
      return true;
    });
    return () => { subscription.remove(); };
  }, [picker]);

  useEventListener(player, 'statusChange', ({ status: next, error }) => {
    setStatus(next);
    if (next === 'error') {
      setFailure(error?.message ?? '系统播放器无法解码此视频源');
      return;
    }
    if (next !== 'readyToPlay') return;
    if (player.duration > 0) setDuration(player.duration);
    if (pendingSeekRef.current !== undefined) {
      player.currentTime = pendingSeekRef.current;
      setCurrentTime(pendingSeekRef.current);
      pendingSeekRef.current = undefined;
    }
    if (autoplayRef.current) {
      autoplayRef.current = false;
      player.play();
    }
  });
  useEventListener(player, 'playingChange', ({ isPlaying: playing }) => {
    setIsPlaying(playing);
    if (playing && !startedRef.current && activeRef.current) {
      startedRef.current = true;
      report(startPlayback);
    } else if (!playing && startedRef.current) {
      report(reportPlaybackProgress);
    }
  });
  useEventListener(player, 'playToEnd', () => {
    if (startedRef.current) report(stopPlayback);
    startedRef.current = false;
    const userId = userIdRef.current;
    if (client && request && userId) {
      void togglePlayed(client, userId, request.itemId, true).catch(() => undefined);
    }
    setControlsVisible(true);
  });
  useEventListener(player, 'timeUpdate', ({ currentTime: time }) => {
    positionRef.current = Math.round(time * TICKS_PER_SECOND);
    setCurrentTime(time);
    if (player.duration > 0) setDuration(player.duration);
  });
  useEventListener(player, 'sourceLoad', (event) => {
    if (event.duration > 0) setDuration(event.duration);
    setAudioTracks(event.availableAudioTracks);
    setSubtitleTracks(event.availableSubtitleTracks);
    setAudioTrack(player.audioTrack);
    setSubtitleTrack(player.subtitleTrack);
  });
  useEventListener(player, 'availableAudioTracksChange', ({ availableAudioTracks }) => {
    setAudioTracks(availableAudioTracks);
  });
  useEventListener(player, 'audioTrackChange', ({ audioTrack: track }) => { setAudioTrack(track); });
  useEventListener(player, 'availableSubtitleTracksChange', ({ availableSubtitleTracks }) => {
    setSubtitleTracks(availableSubtitleTracks);
  });
  useEventListener(player, 'subtitleTrackChange', ({ subtitleTrack: track }) => { setSubtitleTrack(track); });

  const touch = useCallback(() => { setInteraction((value) => value + 1); }, []);

  const seekTo = useCallback((seconds: number) => {
    const limit = player.duration > 0 ? player.duration : duration;
    const next = Math.max(0, limit > 0 ? Math.min(limit, seconds) : seconds);
    if (pendingSeekRef.current !== undefined) pendingSeekRef.current = next;
    else player.currentTime = next;
    positionRef.current = Math.round(next * TICKS_PER_SECOND);
    setCurrentTime(next);
  }, [duration, player]);

  const onScrubbingChange = useCallback((active: boolean) => {
    setScrubbing(active);
    touch();
  }, [touch]);

  function togglePlayback() {
    touch();
    if (player.playing) player.pause();
    else if (duration > 0 && player.currentTime >= duration - 0.5) player.replay();
    else player.play();
  }

  function retry() {
    if (sources.length === 0) void load();
    else void openSource(sources, sourceIndex, positionRef.current);
  }

  function selectOption(kind: PickerKind, key: string) {
    setPicker(undefined);
    touch();
    if (kind === 'source') {
      const index = Number(key);
      if (index !== sourceIndex || failure) void openSource(sources, index, positionRef.current);
    } else if (kind === 'audio') {
      const track = audioTracks[Number(key)];
      if (track) player.audioTrack = track;
    } else {
      player.subtitleTrack = key === 'off' ? null : (subtitleTracks[Number(key)] ?? null);
    }
  }

  const back = () => { router.back(); };

  if (!request) {
    return (
      <View className="flex-1 bg-black" style={{ flex: 1 }}>
        <StatusBar hidden style="light" />
        <PlayerMessage message={failure ?? '没有待播放的内容'} onBack={back} />
      </View>
    );
  }

  const buffering = !failure && (preparing || status === 'loading');
  const pickerOptions = picker ? buildPickerOptions(picker, {
    audioTrack,
    audioTracks,
    sourceIndex,
    sources,
    subtitleTrack,
    subtitleTracks,
  }) : [];

  return (
    <View style={{ backgroundColor: '#000', flex: 1 }}>
      <StatusBar hidden style="light" />
      <VideoView
        allowsPictureInPicture
        contentFit="contain"
        fullscreenOptions={{ enable: false }}
        nativeControls={false}
        player={player}
        surfaceType="textureView"
        style={{ flex: 1, width: '100%' }}
      />
      <TvPressable
        accessibilityLabel={controlsVisible ? '隐藏控制栏' : '显示控制栏'}
        className="absolute inset-0"
        focusScale={1}
        hasTVPreferredFocus={!controlsVisible}
        showFocusFrame={false}
        onPress={() => {
          setControlsVisible((visible) => !visible);
          touch();
        }}
      >
        {null}
      </TvPressable>
      {buffering ? (
        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <Spinner color="#fff" size="lg" />
        </View>
      ) : null}
      {controlsVisible && !failure ? (
        <>
          <SafeAreaView
            edges={['top', 'left', 'right']}
            pointerEvents="box-none"
            style={{ left: 0, position: 'absolute', right: 0, top: 0 }}
          >
            <View className="flex-row items-center gap-3 bg-black/60 px-5 py-3">
              <IconButton icon="arrow-back" label="返回" onPress={back} />
              <Typography className="flex-1 text-base font-semibold text-white" numberOfLines={1}>{title}</Typography>
              {sources.length > 1 ? (
                <IconButton icon="layers-outline" label="视频源" onPress={() => { setPicker('source'); }} />
              ) : null}
              {audioTracks.length > 1 ? (
                <IconButton icon="musical-notes-outline" label="音轨" onPress={() => { setPicker('audio'); }} />
              ) : null}
              {subtitleTracks.length > 0 ? (
                <IconButton icon="chatbox-ellipses-outline" label="字幕" onPress={() => { setPicker('subtitle'); }} />
              ) : null}
            </View>
          </SafeAreaView>
          <View className="absolute inset-0 flex-row items-center justify-center gap-12" pointerEvents="box-none">
            <TvPressable
              accessibilityLabel={`快退 ${SEEK_SECONDS} 秒`}
              className="size-14 items-center justify-center rounded-full bg-black/60"
              focusBorderRadius={28}
              onPress={() => { touch(); seekTo(player.currentTime - SEEK_SECONDS); }}
            >
              <Ionicons color="#fff" name="play-back" size={26} />
            </TvPressable>
            <TvPressable
              accessibilityLabel={isPlaying ? '暂停' : '播放'}
              className="size-20 items-center justify-center rounded-full bg-white"
              focusBorderRadius={40}
              hasTVPreferredFocus={!picker}
              onPress={togglePlayback}
            >
              <Ionicons color="#111" name={isPlaying ? 'pause' : 'play'} size={36} />
            </TvPressable>
            <TvPressable
              accessibilityLabel={`快进 ${SEEK_SECONDS} 秒`}
              className="size-14 items-center justify-center rounded-full bg-black/60"
              focusBorderRadius={28}
              onPress={() => { touch(); seekTo(player.currentTime + SEEK_SECONDS); }}
            >
              <Ionicons color="#fff" name="play-forward" size={26} />
            </TvPressable>
          </View>
          <SafeAreaView
            edges={['bottom', 'left', 'right']}
            pointerEvents="box-none"
            style={{ bottom: 0, left: 0, position: 'absolute', right: 0 }}
          >
            <View className="bg-black/60 px-6 pb-3 pt-2">
              <SeekBar
                currentTime={currentTime}
                duration={duration}
                onScrubbingChange={onScrubbingChange}
                onSeek={seekTo}
              />
            </View>
          </SafeAreaView>
        </>
      ) : null}
      {picker ? (
        <OptionSheet
          options={pickerOptions}
          title={picker === 'source' ? '视频源' : picker === 'audio' ? '音轨' : '字幕'}
          onClose={() => { setPicker(undefined); }}
          onSelect={(key) => { selectOption(picker, key); }}
        />
      ) : null}
      {failure ? (
        <PlayerMessage
          message={failure}
          onBack={back}
          onNextSource={sourceIndex + 1 < sources.length
            ? () => { void openSource(sources, sourceIndex + 1, positionRef.current); }
            : undefined}
          onRetry={retry}
        />
      ) : null}
    </View>
  );
}

function IconButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <TvPressable
      accessibilityLabel={label}
      className="size-11 items-center justify-center rounded-full bg-white/10"
      focusBorderRadius={22}
      onPress={onPress}
    >
      <Ionicons color="#fff" name={icon} size={22} />
    </TvPressable>
  );
}

function SeekBar({
  currentTime,
  duration,
  onScrubbingChange,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onScrubbingChange: (active: boolean) => void;
  onSeek: (seconds: number) => void;
}) {
  const width = useSharedValue(0);
  const progress = useSharedValue(0);
  const scrub = useSharedValue(0);
  const dragging = useSharedValue(false);
  const [preview, setPreview] = useState<number>();

  useEffect(() => {
    progress.value = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  }, [currentTime, duration, progress]);

  const gesture = useMemo(() => {
    const begin = (fraction: number) => {
      onScrubbingChange(true);
      setPreview(Math.floor(fraction * duration));
    };
    const move = (fraction: number) => { setPreview(Math.floor(fraction * duration)); };
    const finish = (fraction: number, commit: boolean) => {
      setPreview(undefined);
      onScrubbingChange(false);
      if (commit) onSeek(fraction * duration);
    };
    const seekAt = (fraction: number) => { onSeek(fraction * duration); };
    const fractionAt = (x: number) => {
      'worklet';
      return width.value > 0 ? Math.min(1, Math.max(0, x / width.value)) : 0;
    };
    const pan = Gesture.Pan()
      .enabled(duration > 0)
      .onStart((event) => {
        dragging.value = true;
        scrub.value = fractionAt(event.x);
        scheduleOnRN(begin, scrub.value);
      })
      .onUpdate((event) => {
        scrub.value = fractionAt(event.x);
        scheduleOnRN(move, scrub.value);
      })
      .onEnd((_event, success) => {
        if (success) progress.value = scrub.value;
        scheduleOnRN(finish, scrub.value, success);
      })
      .onFinalize(() => {
        dragging.value = false;
      });
    const tap = Gesture.Tap()
      .enabled(duration > 0)
      .onEnd((event, success) => {
        if (!success) return;
        const fraction = fractionAt(event.x);
        progress.value = fraction;
        scheduleOnRN(seekAt, fraction);
      });
    return Gesture.Race(pan, tap);
  }, [dragging, duration, onScrubbingChange, onSeek, progress, scrub, width]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${(dragging.value ? scrub.value : progress.value) * 100}%`,
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (dragging.value ? scrub.value : progress.value) * width.value - THUMB_SIZE / 2 }],
  }));

  return (
    <View>
      <GestureDetector gesture={gesture}>
        <View
          style={{ height: 32, justifyContent: 'center' }}
          onLayout={(event) => { width.value = event.nativeEvent.layout.width; }}
        >
          <View className="h-1.5 overflow-hidden rounded-full bg-white/30">
            <Animated.View style={[{ backgroundColor: '#fff', height: '100%' }, fillStyle]} />
          </View>
          <Animated.View
            pointerEvents="none"
            style={[{
              backgroundColor: '#fff',
              borderRadius: THUMB_SIZE / 2,
              height: THUMB_SIZE,
              left: 0,
              position: 'absolute',
              width: THUMB_SIZE,
            }, thumbStyle]}
          />
        </View>
      </GestureDetector>
      <View className="flex-row items-center justify-between">
        <Typography className={`text-sm tabular-nums ${preview === undefined ? 'text-white' : 'font-semibold text-accent'}`}>
          {formatTime(preview ?? currentTime)}
        </Typography>
        <Typography className="text-sm tabular-nums text-white/70">{formatTime(duration)}</Typography>
      </View>
    </View>
  );
}

function OptionSheet({
  title,
  options,
  onClose,
  onSelect,
}: {
  title: string;
  options: PickerOption[];
  onClose: () => void;
  onSelect: (key: string) => void;
}) {
  return (
    <View className="absolute inset-0 flex-row bg-black/50">
      <TvPressable
        accessibilityLabel="关闭"
        className="flex-1"
        focusable={false}
        focusScale={1}
        showFocusFrame={false}
        onPress={onClose}
      >
        {null}
      </TvPressable>
      <SafeAreaView className="w-80 bg-neutral-900" edges={['top', 'bottom', 'right']}>
        <View className="flex-row items-center justify-between px-5 py-3">
          <Typography className="text-base font-semibold text-white">{title}</Typography>
          <TvPressable
            accessibilityLabel="关闭"
            className="size-10 items-center justify-center rounded-full"
            focusBorderRadius={20}
            onPress={onClose}
          >
            <Ionicons color="#fff" name="close" size={22} />
          </TvPressable>
        </View>
        <ScrollView contentContainerStyle={{ gap: 4, paddingBottom: 16, paddingHorizontal: 12 }}>
          {options.map((option) => (
            <TvPressable
              key={option.key}
              accessibilityState={{ selected: option.selected }}
              className={`flex-row items-center gap-3 rounded-lg px-3 py-3 ${option.selected ? 'bg-white/15' : ''}`}
              focusBorderRadius={8}
              focusScale={1}
              hasTVPreferredFocus={option.selected}
              onPress={() => { onSelect(option.key); }}
            >
              <Ionicons color={option.selected ? '#fff' : 'transparent'} name="checkmark" size={18} />
              <Typography className="flex-1 text-sm text-white" numberOfLines={2}>{option.label}</Typography>
            </TvPressable>
          ))}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function PlayerMessage({
  message,
  onBack,
  onNextSource,
  onRetry,
}: {
  message: string;
  onBack: () => void;
  onNextSource?: () => void;
  onRetry?: () => void;
}) {
  return (
    <View className="absolute inset-0 items-center justify-center bg-black/80 px-8">
      <Alert status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>无法播放</Alert.Title>
          <Alert.Description>{message}</Alert.Description>
        </Alert.Content>
      </Alert>
      <View className="mt-4 flex-row flex-wrap justify-center gap-3">
        {onNextSource ? (
          <Button hasTVPreferredFocus onPress={onNextSource}>
            <Button.Label>尝试下一个视频源</Button.Label>
          </Button>
        ) : null}
        {onRetry ? (
          <Button hasTVPreferredFocus={!onNextSource} variant="secondary" onPress={onRetry}>
            <Button.Label>重试</Button.Label>
          </Button>
        ) : null}
        <Button hasTVPreferredFocus={!onNextSource && !onRetry} variant="tertiary" onPress={onBack}>
          <Button.Label>返回</Button.Label>
        </Button>
      </View>
    </View>
  );
}

function buildPickerOptions(kind: PickerKind, state: {
  sources: PlaybackSource[];
  sourceIndex: number;
  audioTracks: AudioTrack[];
  audioTrack: AudioTrack | null;
  subtitleTracks: SubtitleTrack[];
  subtitleTrack: SubtitleTrack | null;
}): PickerOption[] {
  if (kind === 'source') {
    return state.sources.map((source, index) => ({
      key: String(index),
      label: sourceLabel(source, index),
      selected: index === state.sourceIndex,
    }));
  }
  if (kind === 'audio') {
    return state.audioTracks.map((track, index) => ({
      key: String(index),
      label: trackLabel(track, `音轨 ${index + 1}`),
      selected: sameTrack(track, state.audioTrack),
    }));
  }
  return [
    { key: 'off', label: '关闭字幕', selected: state.subtitleTrack === null },
    ...state.subtitleTracks.map((track, index) => ({
      key: String(index),
      label: trackLabel(track, `字幕 ${index + 1}`),
      selected: sameTrack(track, state.subtitleTrack),
    })),
  ];
}

function preferDefault(sources: PlaybackSource[]): PlaybackSource[] {
  return [...sources].sort((left, right) => Number(right.IsDefault === true) - Number(left.IsDefault === true));
}

function sourceLabel(source: PlaybackSource, index: number): string {
  const video = source.MediaStreams?.find((stream) => stream.Type === 'Video');
  const parts = [
    source.Name?.trim() || `视频源 ${index + 1}`,
    video?.Width && video.Height ? `${video.Width}×${video.Height}` : undefined,
    video?.Codec?.toUpperCase(),
    source.Bitrate ? `${(source.Bitrate / 1_000_000).toFixed(1)} Mbps` : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}

function trackLabel(track: AudioTrack | SubtitleTrack, fallback: string): string {
  return track.label?.trim() || track.name?.trim() || track.language?.trim() || fallback;
}

function sameTrack(left: AudioTrack | SubtitleTrack, right: AudioTrack | SubtitleTrack | null): boolean {
  if (!right) return false;
  if (left.id !== undefined || right.id !== undefined) return left.id === right.id;
  return left.language === right.language && left.label === right.label;
}

function resolveStreamUrl(streamUrl: string, serverOrigin: string): string {
  return new URL(streamUrl, serverOrigin.endsWith('/') ? serverOrigin : `${serverOrigin}/`).toString();
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ClientApiError) return CLIENT_ERROR_MESSAGES[error.kind] ?? fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '00:00';
  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
