import { Accordion, Chip, Spinner, Typography } from 'heroui-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { getItems, getLibraryFilterFacets, type ItemPage, type LibraryFilterFacets } from '@tjxy/client-api';
import { useClient } from '../../src/session';
import { EmptyPlaceholder } from '../../src/ui/EmptyPlaceholder';
import { MediaGrid } from '../../src/ui/MediaRow';
import { Page, PageHeader } from '../../src/ui/Page';
import { TvButton as Button } from '../../src/ui/TvButton';

const pageSize = 24;

const sortOptions = [
  { label: '标题 A-Z', value: 'SortName:Ascending' },
  { label: '标题 Z-A', value: 'SortName:Descending' },
  { label: '最新上映', value: 'ProductionYear:Descending' },
  { label: '最早上映', value: 'ProductionYear:Ascending' },
  { label: '最近添加', value: 'DateCreated:Descending' },
] as const;

const typeOptions = [
  { label: '全部媒体', value: '' },
  { label: '电影', value: 'Movie' },
  { label: '剧集', value: 'Series' },
  { label: '音频', value: 'Audio' },
];

export default function LibraryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useClient();
  const router = useRouter();
  const [page, setPage] = useState<ItemPage>();
  const [facets, setFacets] = useState<LibraryFilterFacets>({ Genres: [], ProductionYears: [] });
  const [type, setType] = useState('');
  const [genre, setGenre] = useState('');
  const [year, setYear] = useState('');
  const [sort, setSort] = useState<(typeof sortOptions)[number]>(sortOptions[0]);
  const [pageIndex, setPageIndex] = useState(1);

  useEffect(() => {
    if (!id) return;
    void getLibraryFilterFacets(client, id).then(setFacets).catch(() => {
      setFacets({ Genres: [], ProductionYears: [] });
    });
  }, [client, id]);

  useEffect(() => {
    if (!id) return;
    const [sortBy, sortOrder] = sort.value.split(':') as ['SortName' | 'ProductionYear' | 'DateCreated', 'Ascending' | 'Descending'];
    setPage(undefined);
    void getItems(client, {
      parentId: id,
      genre: genre || undefined,
      includeItemTypes: type || undefined,
      productionYear: year ? Number(year) : undefined,
      recursive: Boolean(type || genre || year),
      sortBy,
      sortOrder,
      limit: pageSize,
      startIndex: (pageIndex - 1) * pageSize,
    }).then(setPage);
  }, [client, genre, id, pageIndex, sort, type, year]);

  const genres = useMemo(() => {
    const values = new Set(facets.Genres);
    if (genre) values.add(genre);
    return [...values].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [facets.Genres, genre]);
  const years = useMemo(() => {
    const values = new Set(facets.ProductionYears.map(String));
    if (year) values.add(year);
    return [...values].sort((left, right) => Number(right) - Number(left));
  }, [facets.ProductionYears, year]);
  const hasFilters = Boolean(type || genre || year || sort.value !== sortOptions[0].value || pageIndex > 1);
  const totalPages = Math.max(1, Math.ceil((page?.TotalRecordCount ?? 0) / pageSize));

  function resetFilters() {
    setType('');
    setGenre('');
    setYear('');
    setSort(sortOptions[0]);
    setPageIndex(1);
  }

  return (
    <Page back>
      <PageHeader description="浏览此媒体库中的电影、剧集和音频。" title="媒体库" />
      <Accordion isCollapsible selectionMode="single" variant="surface">
        <Accordion.Item value="filters">
          <Accordion.Trigger>
            <Typography className="flex-1 font-medium text-foreground">筛选影片</Typography>
            <Accordion.Indicator />
          </Accordion.Trigger>
          <Accordion.Content>
            <View className="gap-4 pb-2">
              <View className="flex-row justify-end">
                <Button isDisabled={!hasFilters} size="sm" variant="tertiary" onPress={resetFilters}>
                  <Button.Label>清除筛选</Button.Label>
                </Button>
              </View>
              <FilterChips
                label="媒体类型"
                options={typeOptions}
                value={type}
                onChange={(value) => { setType(value); setPageIndex(1); }}
              />
              {genres.length > 0 ? (
                <FilterChips
                  label="类型"
                  options={[{ label: '全部类型', value: '' }, ...genres.map((value) => ({ label: value, value }))]}
                  value={genre}
                  onChange={(value) => { setGenre(value); setPageIndex(1); }}
                />
              ) : null}
              {years.length > 0 ? (
                <FilterChips
                  label="年份"
                  options={[{ label: '全部年份', value: '' }, ...years.slice(0, 16).map((value) => ({ label: value, value }))]}
                  value={year}
                  onChange={(value) => { setYear(value); setPageIndex(1); }}
                />
              ) : null}
              <FilterChips
                label="排序"
                options={sortOptions.map((option) => ({ label: option.label, value: option.value }))}
                value={sort.value}
                onChange={(value) => {
                  const next = sortOptions.find((option) => option.value === value);
                  if (next) setSort(next);
                  setPageIndex(1);
                }}
              />
            </View>
          </Accordion.Content>
        </Accordion.Item>
      </Accordion>
      {!page ? (
        <View className="items-center py-20"><Spinner /></View>
      ) : page.Items.length === 0 ? (
        <EmptyPlaceholder
          actionLabel={hasFilters ? '清除筛选' : undefined}
          description={hasFilters ? '清除一个或多个筛选条件以扩大结果范围。' : '这个媒体库里还没有内容。'}
          title={hasFilters ? '没有符合筛选条件的内容' : '媒体库是空的'}
          onAction={hasFilters ? resetFilters : undefined}
        />
      ) : (
        <>
          <MediaGrid items={page.Items} onOpen={(itemId) => { router.push(`/items/${itemId}`); }} />
          {totalPages > 1 ? (
            <View className="flex-row items-center justify-center gap-3">
              <Button isDisabled={pageIndex <= 1} size="sm" variant="secondary" onPress={() => { setPageIndex((current) => current - 1); }}>
                <Button.Label>上一页</Button.Label>
              </Button>
              <Typography className="text-sm text-muted">{pageIndex} / {totalPages}</Typography>
              <Button isDisabled={pageIndex >= totalPages} size="sm" variant="secondary" onPress={() => { setPageIndex((current) => current + 1); }}>
                <Button.Label>下一页</Button.Label>
              </Button>
            </View>
          ) : null}
        </>
      )}
    </Page>
  );
}

function FilterChips({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { label: string; value: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <View className="gap-2">
      <Typography className="text-xs text-muted">{label}</Typography>
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => (
          <Chip
            key={`${label}-${option.value || 'all'}`}
            size="sm"
            variant={value === option.value ? 'primary' : 'soft'}
            onPress={() => { onChange(option.value); }}
          >
            <Chip.Label>{option.label}</Chip.Label>
          </Chip>
        ))}
      </View>
    </View>
  );
}
