import Ionicons from '@expo/vector-icons/Ionicons';
import { Alert, Spinner, Typography } from 'heroui-native';
import { useEventListener } from 'expo';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getItem,
  getPlaybackInfo,
  issuePlaybackTicket,
  reportPlaybackProgress,
  resolveApiUrl,
  revokePlaybackTicket,
  selectNativeSource,
  startPlayback,
  stopPlayback,
  togglePlayed,
} from '@tjxy/client-api';
import { useClient, useSession } from '../../src/session';
import { TvButton as Button } from '../../src/ui/TvButton';
import { TvPressable } from '../../src/ui/TvPressable';

const TICKS_PER_SECOND = 10_000_000;
const SEEK_SECONDS = 10;

export default function PlayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useClient();
  const { user } = useSession();
  const router = useRouter();
  const [title, setTitle] = useState('播放');
  const [error, setError] = useState<string>();
  const [streamUrl, setStreamUrl] = useState<string>();
  const [resumeTicks, setResumeTicks] = useState(0);
  const playbackRef = useRef<{ itemId: string; mediaSourceId: string; playSessionId: string; ticketId: string } | undefined>(undefined);
  const lastProgress = useRef(0);
  const started = useRef(false);

  useEffect(() => {
    if (!id) return;
    let active = true;
    void (async () => {
      try {
        const item = await getItem(client, id);
        if (item.HasMediaSources === false) {
          if (active) setError('没有可用的视频源');
          return;
        }
        const info = await getPlaybackInfo(client, id);
        const source = selectNativeSource(info.MediaSources ?? []);
        if (!source || !info.PlaySessionId) {
          if (active) setError('此影片没有可直接播放的视频源。');
          return;
        }
        const ticket = await issuePlaybackTicket(client, id, source.Id, info.PlaySessionId);
        if (!active) {
          await revokePlaybackTicket(client, ticket.Id);
          return;
        }
        const url = ticket.StreamUrl.startsWith('http')
          ? ticket.StreamUrl
          : resolveApiUrl(ticket.StreamUrl, client.baseUrl);
        const position = item.UserData?.PlaybackPositionTicks ?? 0;
        playbackRef.current = {
          itemId: id,
          mediaSourceId: source.Id,
          playSessionId: info.PlaySessionId,
          ticketId: ticket.Id,
        };
        lastProgress.current = position;
        setTitle(item.Name);
        setResumeTicks(position);
        setStreamUrl(url);
      } catch {
        if (active) setError('无法播放此影片');
      }
    })();
    const progress = setInterval(() => {
      const context = playbackRef.current;
      if (!context || !started.current) return;
      void reportPlaybackProgress(client, { ...context, positionTicks: lastProgress.current });
    }, 15_000);
    return () => {
      active = false;
      clearInterval(progress);
      const context = playbackRef.current;
      if (context) {
        if (started.current) void stopPlayback(client, { ...context, positionTicks: lastProgress.current });
        void revokePlaybackTicket(client, context.ticketId);
      }
    };
  }, [client, id]);

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-6" style={{ flex: 1 }}>
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>无法播放</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
        <Button className="mt-4" onPress={() => { router.back(); }}>
          <Button.Label>返回</Button.Label>
        </Button>
      </View>
    );
  }
  if (!streamUrl) {
    return <View className="flex-1 items-center justify-center bg-background" style={{ flex: 1 }}><Spinner /></View>;
  }

  return (
    <NativePlayer
      resumeTicks={resumeTicks}
      title={title}
      url={streamUrl}
      onBack={() => { router.back(); }}
      onEnded={() => {
        const context = playbackRef.current;
        if (context && user) void togglePlayed(client, user.Id, context.itemId, true);
      }}
      onStarted={() => {
        const context = playbackRef.current;
        if (!context || started.current) return;
        started.current = true;
        void startPlayback(client, { ...context, positionTicks: lastProgress.current });
      }}
      onTicks={(ticks) => { lastProgress.current = ticks; }}
    />
  );
}

function NativePlayer({
  url,
  title,
  resumeTicks,
  onBack,
  onEnded,
  onStarted,
  onTicks,
}: {
  url: string;
  title: string;
  resumeTicks: number;
  onBack: () => void;
  onEnded: () => void;
  onStarted: () => void;
  onTicks: (ticks: number) => void;
}) {
  const controlsReady = useRef(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [currentTime, setCurrentTime] = useState(resumeTicks / TICKS_PER_SECOND);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playerError, setPlayerError] = useState<string>();
  const [preferCenterFocus, setPreferCenterFocus] = useState(true);
  const [seekFeedback, setSeekFeedback] = useState<string>();
  const player = useVideoPlayer(
    {
      uri: url,
      contentType: 'auto',
      metadata: { title },
    },
    (instance) => {
      instance.loop = false;
      instance.staysActiveInBackground = true;
      instance.timeUpdateEventInterval = 1;
      if (resumeTicks > 0) instance.currentTime = resumeTicks / TICKS_PER_SECOND;
      void instance.play();
    },
  );

  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    if (focusTimer.current) clearTimeout(focusTimer.current);
  }, []);

  function seekBy(seconds: number) {
    const knownDuration = player.duration > 0 ? player.duration : duration;
    const nextTime = Math.max(
      0,
      knownDuration > 0
        ? Math.min(knownDuration, player.currentTime + seconds)
        : player.currentTime + seconds,
    );
    player.currentTime = nextTime;
    setCurrentTime(nextTime);
    onTicks(Math.round(nextTime * TICKS_PER_SECOND));
    setSeekFeedback(seconds < 0 ? `-${SEEK_SECONDS} 秒` : `+${SEEK_SECONDS} 秒`);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => { setSeekFeedback(undefined); }, 900);
  }

  function seekFromRemote(seconds: number) {
    if (!controlsReady.current) return;
    seekBy(seconds);
    setPreferCenterFocus(false);
    if (focusTimer.current) clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => { setPreferCenterFocus(true); }, 50);
  }

  function togglePlayback() {
    if (player.playing) player.pause();
    else player.play();
  }

  useEventListener(player, 'statusChange', ({ status, error }) => {
    if (status === 'error') setPlayerError(error?.message ?? '系统播放器无法解码此视频源。');
    if (status === 'readyToPlay') {
      setDuration(player.duration);
      onStarted();
    }
  });
  useEventListener(player, 'playingChange', ({ isPlaying }) => {
    setIsPlaying(isPlaying);
    if (isPlaying) onStarted();
  });
  useEventListener(player, 'playToEnd', () => { onEnded(); });
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    setCurrentTime(currentTime ?? 0);
    if (player.duration > 0) setDuration(player.duration);
    onTicks(Math.round((currentTime ?? 0) * TICKS_PER_SECOND));
  });

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <View style={{ backgroundColor: '#000', flex: 1 }}>
      <VideoView
        allowsPictureInPicture
        contentFit="contain"
        fullscreenOptions={{ enable: false }}
        nativeControls={false}
        player={player}
        surfaceType="textureView"
        style={{ flex: 1, width: '100%' }}
        onFirstFrameRender={onStarted}
      />
      <SafeAreaView edges={['top']} pointerEvents="box-none" style={{ left: 0, position: 'absolute', right: 0, top: 0 }}>
        <View className="flex-row items-center gap-3 px-5 py-3" pointerEvents="box-none">
          <TvPressable
            accessibilityLabel="返回"
            className="size-11 items-center justify-center rounded-full bg-black/70"
            focusBorderRadius={22}
            onPress={onBack}
          >
            <Ionicons color="#fff" name="arrow-back" size={24} />
          </TvPressable>
          <Typography className="flex-1 text-base font-semibold text-white" numberOfLines={1}>{title}</Typography>
        </View>
      </SafeAreaView>
      {seekFeedback ? (
        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <View className="rounded-md bg-black/75 px-5 py-3">
            <Typography className="text-xl font-semibold text-white">{seekFeedback}</Typography>
          </View>
        </View>
      ) : null}
      <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={{ bottom: 0, left: 0, position: 'absolute', right: 0 }}>
        <View className="gap-3 bg-black/70 px-6 pb-4 pt-3">
          <View className="h-1.5 overflow-hidden rounded-full bg-white/30">
            <View className="h-full bg-white" style={{ width: `${progress * 100}%` }} />
          </View>
          <View className="flex-row items-center justify-between">
            <Typography className="w-36 text-sm tabular-nums text-white">
              {formatTime(currentTime)} / {formatTime(duration)}
            </Typography>
            <View className="flex-row items-center gap-5">
              <TvPressable
                accessibilityLabel={`快退 ${SEEK_SECONDS} 秒`}
                className="size-12 items-center justify-center rounded-full bg-white/15"
                focusBorderRadius={24}
                onFocus={() => { seekFromRemote(-SEEK_SECONDS); }}
                onPress={() => { seekBy(-SEEK_SECONDS); }}
              >
                <Ionicons color="#fff" name="play-back" size={25} />
              </TvPressable>
              <TvPressable
                accessibilityLabel={isPlaying ? '暂停' : '播放'}
                className="size-14 items-center justify-center rounded-full bg-white"
                focusBorderRadius={28}
                hasTVPreferredFocus={preferCenterFocus}
                onFocus={() => { controlsReady.current = true; }}
                onPress={togglePlayback}
              >
                <Ionicons color="#111" name={isPlaying ? 'pause' : 'play'} size={29} />
              </TvPressable>
              <TvPressable
                accessibilityLabel={`快进 ${SEEK_SECONDS} 秒`}
                className="size-12 items-center justify-center rounded-full bg-white/15"
                focusBorderRadius={24}
                onFocus={() => { seekFromRemote(SEEK_SECONDS); }}
                onPress={() => { seekBy(SEEK_SECONDS); }}
              >
                <Ionicons color="#fff" name="play-forward" size={25} />
              </TvPressable>
            </View>
            <View className="w-36" />
          </View>
        </View>
      </SafeAreaView>
      {playerError ? (
        <View className="absolute bottom-10 left-5 right-5">
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>系统解码失败</Alert.Title>
              <Alert.Description>{playerError}</Alert.Description>
            </Alert.Content>
          </Alert>
        </View>
      ) : null}
    </View>
  );
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
