import { SearchField } from 'heroui-native';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { getPopular, searchHints, type MediaItem } from '@tjxy/client-api';
import { useClient } from '../../src/session';
import { EmptyPlaceholder } from '../../src/ui/EmptyPlaceholder';
import { MediaGrid, MediaRow, PosterGridSkeleton } from '../../src/ui/MediaRow';
import { Page, PageHeader } from '../../src/ui/Page';

export default function SearchScreen() {
  const client = useClient();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MediaItem[]>([]);
  const [popular, setPopular] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void getPopular(client, 12).then(setPopular).catch(() => { setPopular([]); });
  }, [client]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      setLoading(true);
      void searchHints(client, query)
        .then(setResults)
        .catch(() => { setResults([]); })
        .finally(() => { setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); };
  }, [client, query]);

  return (
    <Page padded={false}>
      <View className="gap-6 px-5">
        <PageHeader description="寻找想看的内容。" eyebrow="探索媒体库" title="搜索" />
        <SearchField value={query} onChange={setQuery}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="搜索电影、剧集和单集" />
          </SearchField.Group>
        </SearchField>
      </View>
      {loading ? (
        <PosterGridSkeleton count={6} />
      ) : query.trim() && results.length === 0 ? (
        <EmptyPlaceholder
          actionLabel="清除搜索"
          description={`没有找到 “${query}”。`}
          inset
          title="没有结果"
          onAction={() => { setQuery(''); }}
        />
      ) : results.length > 0 ? (
        <View className="px-5">
          <MediaGrid items={results} onOpen={(id) => { router.push(`/items/${id}`); }} />
        </View>
      ) : (
        <MediaRow
          items={popular}
          limitToTwoRows
          title="热门推荐"
          onMore={() => { router.push('/rankings'); }}
          onOpen={(id) => { router.push(`/items/${id}`); }}
        />
      )}
    </Page>
  );
}
