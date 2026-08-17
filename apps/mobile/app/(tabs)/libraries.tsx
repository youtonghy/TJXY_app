import { Alert } from 'heroui-native';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getLatest, getLibraries, latestTypesForLibrary, type Library, type MediaItem } from '@tjxy/client-api';
import { useClient } from '../../src/session';
import { EmptyPlaceholder } from '../../src/ui/EmptyPlaceholder';
import { MediaRow, PosterGridSkeleton } from '../../src/ui/MediaRow';
import { Page, PageHeader } from '../../src/ui/Page';

export default function LibrariesScreen() {
  const client = useClient();
  const router = useRouter();
  const [rows, setRows] = useState<{ library: Library; items: MediaItem[] }[]>();
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void getLibraries(client).then(async (libraries) => {
      const results = await Promise.allSettled(libraries.map(async (library) => ({
        library,
        items: await getLatest(client, {
          includeItemTypes: latestTypesForLibrary(library),
          limit: 12,
          parentId: library.Id,
        }),
      })));
      if (!active) return;
      setRows(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])));
      setUnavailable(results.some((result) => result.status === 'rejected'));
    }).catch(() => {
      if (active) {
        setRows([]);
        setUnavailable(true);
      }
    });
    return () => { active = false; };
  }, [client]);

  return (
    <Page padded={false}>
      <View className="px-5">
        <PageHeader
          description="浏览此账户可用的全部媒体库。"
          eyebrow="你的收藏"
          title="媒体库"
        />
      </View>
      {unavailable ? (
        <View className="px-5">
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>部分媒体库暂时不可用</Alert.Title>
              <Alert.Description>请稍后重试。</Alert.Description>
            </Alert.Content>
          </Alert>
        </View>
      ) : null}
      {!rows ? (
        <PosterGridSkeleton count={6} />
      ) : rows.length === 0 ? (
        <EmptyPlaceholder description="请先在服务器创建媒体库。" inset title="暂无可用的媒体库" />
      ) : (
        <View className="gap-8">
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
