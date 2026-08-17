import Ionicons from '@expo/vector-icons/Ionicons';
import { Chip, Spinner, Tabs, Typography } from 'heroui-native';
import { useThemeColor } from 'heroui-native/hooks';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import {
  getServerRanking,
  getTmdbRanking,
  type ServerRankingItem,
  type TmdbRankingItem,
} from '@tjxy/client-api';
import { typeLabel } from '../../src/labels';
import { Poster } from '../../src/Poster';
import { useClient } from '../../src/session';
import { EmptyPlaceholder } from '../../src/ui/EmptyPlaceholder';
import { Page, PageHeader } from '../../src/ui/Page';
import { TvPressable } from '../../src/ui/TvPressable';

type RankingTab = 'movies' | 'series' | 'server';

export default function RankingsScreen() {
  const client = useClient();
  const router = useRouter();
  const [tab, setTab] = useState<RankingTab>('movies');
  const [movies, setMovies] = useState<TmdbRankingItem[]>();
  const [series, setSeries] = useState<TmdbRankingItem[]>();
  const [server, setServer] = useState<ServerRankingItem[]>();
  const [movieError, setMovieError] = useState(false);
  const [seriesError, setSeriesError] = useState(false);
  const [serverError, setServerError] = useState(false);

  useEffect(() => {
    void getTmdbRanking(client, 'Movie').then(setMovies).catch(() => { setMovieError(true); setMovies([]); });
    void getTmdbRanking(client, 'Series').then(setSeries).catch(() => { setSeriesError(true); setSeries([]); });
    void getServerRanking(client).then(setServer).catch(() => { setServerError(true); setServer([]); });
  }, [client]);

  return (
    <Page>
      <PageHeader
        description="查看 TMDB 高分电影、热门剧集与本站昨日播放排行。"
        eyebrow="大家都在看"
        title="排行榜"
      />
      <Tabs value={tab} variant="secondary" onValueChange={(value) => { setTab(value as RankingTab); }}>
        <Tabs.List>
          <Tabs.Indicator />
          <Tabs.Trigger value="movies"><Tabs.Label>高分电影</Tabs.Label></Tabs.Trigger>
          <Tabs.Trigger value="series"><Tabs.Label>热门剧集</Tabs.Label></Tabs.Trigger>
          <Tabs.Trigger value="server"><Tabs.Label>昨日排行</Tabs.Label></Tabs.Trigger>
        </Tabs.List>
      </Tabs>
      {tab === 'movies' ? (
        <TmdbList
          error={movieError}
          errorText="TMDB 排行暂不可用，请检查 TMDB 设置与网络连接。"
          items={movies}
          onOpen={(id) => { router.push(`/items/${id}`); }}
        />
      ) : null}
      {tab === 'series' ? (
        <TmdbList
          error={seriesError}
          errorText="TMDB 剧集排行暂不可用。"
          items={series}
          onOpen={(id) => { router.push(`/items/${id}`); }}
        />
      ) : null}
      {tab === 'server' ? (
        <ServerList
          error={serverError}
          items={server}
          onOpen={(id) => { router.push(`/items/${id}`); }}
        />
      ) : null}
    </Page>
  );
}

function TmdbList({
  items,
  error,
  errorText,
  onOpen,
}: {
  items?: TmdbRankingItem[];
  error: boolean;
  errorText: string;
  onOpen: (id: string) => void;
}) {
  const accent = useThemeColor('accent');
  if (!items) return <View className="items-center py-12"><Spinner /></View>;
  if (error) return <EmptyPlaceholder description={errorText} title="排行暂不可用" />;
  if (items.length === 0) return <EmptyPlaceholder description="TMDB 暂未返回任何影片。" title="暂无排行" />;
  return (
    <View>
      {items.map((item) => (
        <TvPressable
          className="flex-row items-start gap-3 border-b border-separator py-3"
          disabled={!item.LocalItemId}
          focusBorderRadius={8}
          focusScale={1.01}
          key={item.TmdbId}
          onPress={() => { if (item.LocalItemId) onOpen(item.LocalItemId); }}
        >
          <Typography className="w-8 pt-1 text-lg font-semibold text-accent">#{item.Rank}</Typography>
          {item.PosterUrl ? (
            <Image source={{ uri: item.PosterUrl }} style={{ borderRadius: 6, height: 80, width: 56 }} />
          ) : (
            <View className="h-20 w-14 rounded-md bg-default" />
          )}
          <View className="min-w-0 flex-1 gap-1">
            <Typography className="font-medium text-foreground" numberOfLines={1}>{item.Name}</Typography>
            <Typography className="text-xs leading-5 text-muted" numberOfLines={2}>
              {item.Overview ?? '暂无简介。'}
            </Typography>
            <View className="flex-row items-center gap-3">
              <Typography className="text-xs text-muted">{item.ProductionYear ?? '—'}</Typography>
              {item.Rating !== undefined ? (
                <View className="flex-row items-center gap-1">
                  <Ionicons color={accent} name="star" size={12} />
                  <Typography className="text-xs tabular-nums text-muted">{item.Rating.toFixed(1)}</Typography>
                </View>
              ) : null}
            </View>
          </View>
        </TvPressable>
      ))}
    </View>
  );
}

function ServerList({
  items,
  error,
  onOpen,
}: {
  items?: ServerRankingItem[];
  error: boolean;
  onOpen: (id: string) => void;
}) {
  if (!items) return <View className="items-center py-12"><Spinner /></View>;
  if (error) return <EmptyPlaceholder description="昨日本站排行暂不可用。" title="排行暂不可用" />;
  if (items.length === 0) return <EmptyPlaceholder description="昨日没有播放记录。" title="暂无排行" />;
  return (
    <View>
      {items.map((item) => (
        <TvPressable
          className="flex-row items-start gap-3 border-b border-separator py-3"
          focusBorderRadius={8}
          focusScale={1.01}
          key={item.Id}
          onPress={() => { onOpen(item.Id); }}
        >
          <Typography className="w-8 pt-1 text-lg font-semibold text-accent">#{item.Rank}</Typography>
          <View className="overflow-hidden rounded-md">
            <Poster height={80} item={{ Id: item.Id, Name: item.Name, PrimaryImageTag: item.PrimaryImageTag }} width={56} />
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Typography className="font-medium text-foreground" numberOfLines={1}>{item.Name}</Typography>
            <Typography className="text-xs leading-5 text-muted" numberOfLines={2}>
              {item.Overview ?? '暂无简介。'}
            </Typography>
            <View className="flex-row flex-wrap items-center gap-2">
              <Chip size="sm" variant="soft"><Chip.Label>{typeLabel(item.ItemType)}</Chip.Label></Chip>
              <Typography className="text-xs tabular-nums text-muted">
                {item.PlayCount} 次 · {item.UniqueViewers} 人
              </Typography>
            </View>
          </View>
        </TvPressable>
      ))}
    </View>
  );
}
