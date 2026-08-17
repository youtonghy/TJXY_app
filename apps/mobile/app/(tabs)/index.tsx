import { Alert } from 'heroui-native';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getLatest, getLibraries, getResumeItems, latestTypesForLibrary, type Library, type MediaItem } from '@tjxy/client-api';
import { useClient } from '../../src/session';
import { EmptyPlaceholder } from '../../src/ui/EmptyPlaceholder';
import { MediaRow, PosterGridSkeleton } from '../../src/ui/MediaRow';
import { Page, PageHeader } from '../../src/ui/Page';

export default function HomeScreen() {
  const client = useClient();
  const router = useRouter();
  const [resume, setResume] = useState<MediaItem[]>([]);
  const [rows, setRows] = useState<{ library: Library; items: MediaItem[] }[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([getResumeItems(client), getLibraries(client)])
      .then(async ([resumeItems, libraries]) => {
        const results = await Promise.allSettled(libraries.map(async (library) => ({
          library,
          items: await getLatest(client, {
            includeItemTypes: latestTypesForLibrary(library),
            limit: 12,
            parentId: library.Id,
          }),
        })));
        if (!active) return;
        setResume(resumeItems);
        setRows(results.flatMap((result) => (
          result.status === 'fulfilled' && result.value.items.length > 0 ? [result.value] : []
        )));
        setUnavailable(results.some((result) => result.status === 'rejected'));
      })
      .catch(() => { if (active) setUnavailable(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client]);

  const empty = !loading && resume.length === 0 && rows.length === 0;

  return (
    <Page padded={false}>
      <View className="px-5">
        <PageHeader
          description="从上次离开的地方继续，或探索新的内容。"
          eyebrow="你的媒体库"
          title="今天想看什么？"
        />
      </View>
      {unavailable ? (
        <View className="px-5">
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>部分媒体库暂时不可用</Alert.Title>
              <Alert.Description>下拉刷新或稍后再试。</Alert.Description>
            </Alert.Content>
          </Alert>
        </View>
      ) : null}
      {loading ? (
        <PosterGridSkeleton count={6} />
      ) : empty ? (
        <EmptyPlaceholder
          description="在服务器添加媒体后，首页会出现继续观看和媒体库推荐。"
          inset
          title="还没有影片"
        />
      ) : (
        <View className="gap-10">
          <MediaRow items={resume} title="继续观看" onOpen={(id) => { router.push(`/play/${id}`); }} />
          {rows.map((row) => (
            <MediaRow
              items={row.items}
              key={row.library.Id}
              limitToTwoRows
              title={row.library.Name}
              onMore={() => { router.push(`/libraries/${row.library.Id}`); }}
              onOpen={(id) => { router.push(`/items/${id}`); }}
            />
          ))}
        </View>
      )}
    </Page>
  );
}
