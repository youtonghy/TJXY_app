import { Alert, Avatar, Card, Chip, Spinner, Typography } from 'heroui-native';
import { useThemeColor } from 'heroui-native/hooks';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import {
  getChildren,
  getItem,
  getSimilarItems,
  toggleFavorite,
  togglePlayed,
  type MediaItem,
  type MediaPerson,
} from '@tjxy/client-api';
import { formatDate, formatRuntime, personTypeLabel, sortByIndex, typeLabel } from '../../src/labels';
import { Poster } from '../../src/Poster';
import { TvPressable } from '../../src/ui/TvPressable';
import { TvButton as Button } from '../../src/ui/TvButton';
import { useClient, useSession } from '../../src/session';
import { MediaRow } from '../../src/ui/MediaRow';
import { Page } from '../../src/ui/Page';

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useClient();
  const { user } = useSession();
  const router = useRouter();
  const { height, width } = useWindowDimensions();
  const [item, setItem] = useState<MediaItem>();
  const [children, setChildren] = useState<MediaItem[]>([]);
  const [similar, setSimilar] = useState<MediaItem[]>();
  const [similarFailed, setSimilarFailed] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!id) return;
    setFailed(false);
    setItem(undefined);
    setChildren([]);
    setSimilar(undefined);
    setSimilarFailed(false);
    void getItem(client, id)
      .then(async (next) => {
        setItem(next);
        if (next.IsFolder) setChildren(await getChildren(client, next.Id));
        if (next.Type === 'Movie' || next.Type === 'Series') {
          try {
            const items = await getSimilarItems(client, next.Id, 8);
            setSimilar(items
              .filter((candidate) => candidate.Id !== next.Id && candidate.Type === next.Type && candidate.UserData?.Played !== true)
              .slice(0, 8));
          } catch {
            setSimilarFailed(true);
            setSimilar([]);
          }
        }
      })
      .catch(() => { setFailed(true); });
  }, [client, id]);

  if (failed) {
    return (
      <Page back>
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>无法加载此影片</Alert.Title>
            <Alert.Description>请返回媒体库后重试。</Alert.Description>
          </Alert.Content>
        </Alert>
      </Page>
    );
  }

  if (!item) {
    return (
      <Page back>
        <View className="items-center py-20">
          <Spinner />
        </View>
      </Page>
    );
  }

  const favorite = item.UserData?.IsFavorite === true;
  const played = item.UserData?.Played === true;
  const hasPlayableAction = item.Type !== 'Series' && item.Type !== 'Season';
  const seasons = children.filter((child) => child.Type === 'Season').sort(sortByIndex);
  const episodes = children.filter((child) => child.Type === 'Episode').sort(sortByIndex);
  const otherChildren = children.filter((child) => child.Type !== 'Season' && child.Type !== 'Episode');
  const parallelDetails = width >= 768 || (width >= 640 && width > height);
  const posterWidth = parallelDetails ? 152 : 104;
  const handleFavorite = () => {
    if (!user || !id) return;
    void toggleFavorite(client, user.Id, id, !favorite).then(() => {
      setItem({ ...item, UserData: { ...item.UserData, IsFavorite: !favorite } });
    });
  };
  const handlePlayed = () => {
    if (!user || !id) return;
    void togglePlayed(client, user.Id, id, !played).then(() => {
      setItem({ ...item, UserData: { ...item.UserData, Played: !played } });
    });
  };

  return (
    <Page back>
      <View className="gap-4">
        <View className="flex-row items-start gap-4">
          <View className="overflow-hidden rounded-2xl bg-default" style={{ borderRadius: 16, width: posterWidth }}>
            <Poster fill item={item} />
          </View>
          <View className="min-w-0 flex-1 gap-2">
            <View className="flex-row flex-wrap gap-1.5">
              {item.Type ? (
                <Chip color="accent" size="sm" variant="soft">
                  <Chip.Label>{typeLabel(item.Type)}</Chip.Label>
                </Chip>
              ) : null}
              {item.ProductionYear ? (
                <Chip size="sm" variant="secondary">
                  <Chip.Label>{String(item.ProductionYear)}</Chip.Label>
                </Chip>
              ) : null}
              {item.Status ? (
                <Chip color="success" size="sm" variant="soft">
                  <Chip.Label>{item.Status}</Chip.Label>
                </Chip>
              ) : null}
              {item.OfficialRating ? (
                <Chip size="sm" variant="secondary">
                  <Chip.Label>{item.OfficialRating}</Chip.Label>
                </Chip>
              ) : null}
            </View>
            <Typography className="text-xl font-semibold text-foreground">{item.Name}</Typography>
            {item.OriginalTitle && item.OriginalTitle !== item.Name ? (
              <Typography className="text-sm text-muted">{item.OriginalTitle}</Typography>
            ) : null}
            {item.Tagline ? (
              <Typography className="text-sm italic text-accent">“{item.Tagline}”</Typography>
            ) : null}
            {parallelDetails ? (
              <ItemActions
                favorite={favorite}
                hasPlayableAction={hasPlayableAction}
                item={item}
                played={played}
                onFavorite={handleFavorite}
                onPlay={() => { router.push(`/play/${item.Id}`); }}
                onPlayed={handlePlayed}
              />
            ) : null}
          </View>
        </View>
        {!parallelDetails ? (
          <ItemActions
            favorite={favorite}
            hasPlayableAction={hasPlayableAction}
            item={item}
            played={played}
            onFavorite={handleFavorite}
            onPlay={() => { router.push(`/play/${item.Id}`); }}
            onPlayed={handlePlayed}
          />
        ) : null}
      </View>
      {item.Overview ? (
        <Typography.Paragraph className="text-sm leading-6 text-muted">{item.Overview}</Typography.Paragraph>
      ) : null}
      {hasPlayableAction && item.HasMediaSources === false ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>没有可用的视频源</Alert.Title>
            <Alert.Description>开始播放前，请先为此影片添加媒体文件。</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {seasons.length > 0 ? <SeasonBrowser seasons={seasons} /> : null}
      {episodes.length > 0 ? (
        <ChildList
          items={episodes}
          title="剧集"
          onOpen={(itemId) => { router.push(`/play/${itemId}`); }}
        />
      ) : null}
      {otherChildren.length > 0 ? (
        <ChildList
          items={otherChildren}
          title="内容"
          onOpen={(itemId, child) => {
            router.push(child.IsFolder ? `/items/${itemId}` : `/play/${itemId}`);
          }}
        />
      ) : null}
      <View className={parallelDetails ? 'flex-row items-start gap-4' : 'gap-4'}>
        <View style={parallelDetails ? { flex: 1, minWidth: 0 } : undefined}>
          <MetadataCard item={item} />
        </View>
        <View style={parallelDetails ? { flex: 1, minWidth: 0 } : undefined}>
          <TaxonomyCard item={item} />
        </View>
      </View>
      {item.People && item.People.length > 0 ? <PeopleCard parallel={parallelDetails} people={item.People} /> : null}
      {item.Type === 'Movie' || item.Type === 'Series' ? (
        similarFailed ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>推荐暂时不可用</Alert.Title>
            </Alert.Content>
          </Alert>
        ) : similar && similar.length > 0 ? (
          <View className="-mx-5">
            <MediaRow items={similar} title="为你推荐" onOpen={(itemId) => { router.push(`/items/${itemId}`); }} />
          </View>
        ) : similar ? (
          <Typography className="text-sm text-muted">暂无推荐</Typography>
        ) : (
          <View className="items-center py-6"><Spinner /></View>
        )
      ) : null}
    </Page>
  );
}

function ItemActions({
  favorite,
  hasPlayableAction,
  item,
  played,
  onFavorite,
  onPlay,
  onPlayed,
}: {
  favorite: boolean;
  hasPlayableAction: boolean;
  item: MediaItem;
  played: boolean;
  onFavorite: () => void;
  onPlay: () => void;
  onPlayed: () => void;
}) {
  const [accentForeground, foreground] = useThemeColor(['accent-foreground', 'foreground']);
  return (
    <View className="mt-1 flex-row flex-wrap gap-2">
      {hasPlayableAction ? (
        <Button isDisabled={item.HasMediaSources === false} size="sm" onPress={onPlay}>
          <Ionicons color={accentForeground} name="play" size={14} />
          <Button.Label>播放</Button.Label>
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" onPress={onFavorite}>
        <Ionicons color={foreground} name={favorite ? 'heart' : 'heart-outline'} size={14} />
        <Button.Label>{favorite ? '取消收藏' : '收藏'}</Button.Label>
      </Button>
      <Button size="sm" variant="tertiary" onPress={onPlayed}>
        <Ionicons color={foreground} name="checkmark" size={14} />
        <Button.Label>{played ? '标记为未看' : '标记为已看'}</Button.Label>
      </Button>
    </View>
  );
}

function MetadataCard({ item }: { item: MediaItem }) {
  const facts = [
    formatRuntime(item.RunTimeTicks) ? { label: '片长', value: formatRuntime(item.RunTimeTicks)! } : undefined,
    formatDate(item.PremiereDate) ? { label: '首映', value: formatDate(item.PremiereDate)! } : undefined,
    formatDate(item.EndDate) ? { label: '完结', value: formatDate(item.EndDate)! } : undefined,
    item.OriginalLanguage ? { label: '原始语言', value: item.OriginalLanguage.toUpperCase() } : undefined,
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact));

  return (
    <Card className="rounded-lg" style={{ borderRadius: 8 }}>
      <Card.Body className="gap-3 p-4">
        <Card.Title className="text-base font-semibold">详细信息</Card.Title>
        <Card.Description className="text-sm">媒体目录记录中的主要信息。</Card.Description>
        {item.CommunityRating !== undefined ? (
          <View className="gap-1">
            <Typography className="text-xs text-muted">评分</Typography>
            <Typography className="font-medium text-foreground">
              {item.CommunityRating.toFixed(1)}
              {item.VoteCount ? ` · ${item.VoteCount} 票` : ''}
            </Typography>
          </View>
        ) : null}
        {facts.map((fact) => (
          <View className="gap-1" key={fact.label}>
            <Typography className="text-xs text-muted">{fact.label}</Typography>
            <Typography className="font-medium text-foreground">{fact.value}</Typography>
          </View>
        ))}
        {item.CommunityRating === undefined && facts.length === 0 ? (
          <Typography className="text-sm text-muted">暂无更多详细信息。</Typography>
        ) : null}
      </Card.Body>
    </Card>
  );
}

function TaxonomyCard({ item }: { item: MediaItem }) {
  const groups = [
    { label: '类型', values: item.Genres },
    { label: '制作公司', values: item.Studios },
    { label: '国家与地区', values: item.Countries?.map((value) => value.Name) },
    { label: '语言', values: item.Languages?.map((value) => value.Name) },
  ].filter((group) => group.values && group.values.length > 0);

  return (
    <Card className="rounded-lg" style={{ borderRadius: 8 }}>
      <Card.Body className="gap-4 p-4">
        <Card.Title className="text-base font-semibold">分类信息</Card.Title>
        <Card.Description className="text-sm">类型、制作与语言元数据。</Card.Description>
        {groups.length === 0 ? (
          <Typography className="text-sm text-muted">暂无分类元数据。</Typography>
        ) : groups.map((group) => (
          <View className="gap-2" key={group.label}>
            <Typography className="text-xs text-muted">{group.label}</Typography>
            <View className="flex-row flex-wrap gap-2">
              {group.values?.map((value) => (
                <Chip key={value} size="sm" variant="soft">
                  <Chip.Label>{value}</Chip.Label>
                </Chip>
              ))}
            </View>
          </View>
        ))}
      </Card.Body>
    </Card>
  );
}

function PeopleCard({ parallel, people }: { parallel: boolean; people: MediaPerson[] }) {
  const [expanded, setExpanded] = useState(false);
  const previewCount = 6;
  const visible = expanded ? people : people.slice(0, previewCount);

  return (
    <Card>
      <Card.Body className="gap-3 p-5">
        <Card.Title>演职人员</Card.Title>
        <Card.Description>参与此影片的演职人员。</Card.Description>
        <View className="flex-row flex-wrap gap-3">
        {visible.map((person) => (
          <View
            className="flex-row items-center gap-3"
            key={`${person.Id}-${person.Role ?? ''}`}
            style={parallel ? { flexBasis: '47%', flexGrow: 1, minWidth: 180 } : { width: '100%' }}
          >
            <Avatar color={person.Type === 'Crew' ? 'accent' : 'default'} size="sm">
              <Avatar.Fallback>{person.Name.slice(0, 1).toUpperCase()}</Avatar.Fallback>
            </Avatar>
            <View className="min-w-0 flex-1">
              <Typography className="text-sm font-medium text-foreground" numberOfLines={1}>{person.Name}</Typography>
              <Typography className="text-xs text-muted" numberOfLines={1}>
                {[person.Role, personTypeLabel(person.Type)].filter(Boolean).join(' · ')}
              </Typography>
            </View>
          </View>
        ))}
        </View>
        {people.length > previewCount ? (
          <Button size="sm" variant="ghost" onPress={() => { setExpanded((current) => !current); }}>
            <Button.Label>
              {expanded ? '收起演职人员' : `查看全部 ${people.length} 位演职人员`}
            </Button.Label>
          </Button>
        ) : null}
      </Card.Body>
    </Card>
  );
}

function SeasonBrowser({ seasons }: { seasons: MediaItem[] }) {
  const client = useClient();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(seasons[0]?.Id ?? '');
  const [episodes, setEpisodes] = useState<MediaItem[]>();
  const selected = seasons.find((season) => season.Id === selectedId) ?? seasons[0];

  useEffect(() => {
    if (!selected) return;
    setEpisodes(undefined);
    void getChildren(client, selected.Id).then((items) => {
      setEpisodes(items.filter((item) => item.Type === 'Episode').sort(sortByIndex));
    });
  }, [client, selected]);

  return (
    <Card>
      <Card.Body className="gap-3 p-5">
        <Card.Title>季</Card.Title>
        <Card.Description>浏览每一季的剧集。</Card.Description>
        <View className="flex-row flex-wrap gap-2">
          {seasons.map((season) => (
            <Chip
              key={season.Id}
              size="sm"
              variant={season.Id === selected?.Id ? 'primary' : 'soft'}
              onPress={() => { setSelectedId(season.Id); }}
            >
              <Chip.Label>{season.Name}</Chip.Label>
            </Chip>
          ))}
        </View>
        {!episodes ? (
          <View className="items-center py-6"><Spinner /></View>
        ) : episodes.length === 0 ? (
          <Typography className="text-sm text-muted">这一季还没有剧集。</Typography>
        ) : (
          <ChildList
            items={episodes}
            title=""
            onOpen={(itemId) => { router.push(`/play/${itemId}`); }}
          />
        )}
      </Card.Body>
    </Card>
  );
}

function ChildList({
  items,
  title,
  onOpen,
}: {
  items: MediaItem[];
  title: string;
  onOpen: (id: string, item: MediaItem) => void;
}) {
  return (
    <View className="gap-3">
      {title ? <Typography className="font-semibold text-foreground">{title}</Typography> : null}
      {items.map((child) => (
        <TvPressable
          className="flex-row items-center gap-3 overflow-hidden rounded-lg border border-border bg-surface p-3"
          focusBorderRadius={8}
          focusScale={1.01}
          key={child.Id}
          onPress={() => { onOpen(child.Id, child); }}
        >
          <View className="overflow-hidden rounded-md" style={{ borderRadius: 6 }}>
            <Poster height={84} item={child} width={56} />
          </View>
          <View className="min-w-0 flex-1 gap-1">
            {child.Type === 'Episode' && child.IndexNumber !== undefined ? (
              <Typography className="text-xs font-semibold text-accent">E{String(child.IndexNumber)}</Typography>
            ) : null}
            <Typography className="font-medium text-foreground" numberOfLines={2}>{child.Name}</Typography>
            {child.ProductionYear ? (
              <Typography className="text-xs text-muted">{String(child.ProductionYear)}</Typography>
            ) : null}
          </View>
        </TvPressable>
      ))}
    </View>
  );
}
