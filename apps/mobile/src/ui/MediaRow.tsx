import { Skeleton, Typography } from 'heroui-native';
import { useWindowDimensions, View } from 'react-native';
import type { MediaItem } from '@tjxy/client-api';
import { MediaTile } from './MediaTile';
import { TvPressable } from './TvPressable';

const GRID_GAP = 16;
const PAGE_INSET = 20;

export function usePosterColumns(): number {
  const { width } = useWindowDimensions();
  if (width >= 900) return 6;
  if (width >= 640) return 4;
  return 2;
}

export function usePosterTileWidth(): number {
  const { width } = useWindowDimensions();
  const columns = usePosterColumns();
  return (width - PAGE_INSET * 2 - GRID_GAP * (columns - 1)) / columns;
}

export function MediaRow({
  title,
  items,
  limitToTwoRows = false,
  onOpen,
  onMore,
}: {
  title: string;
  items: MediaItem[];
  limitToTwoRows?: boolean;
  onOpen: (id: string) => void;
  onMore?: () => void;
}) {
  const columns = usePosterColumns();
  if (items.length === 0) return null;
  const visible = limitToTwoRows ? items.slice(0, columns * 2) : items;
  return (
    <View className="gap-3 px-5">
      <View className="flex-row items-center justify-between gap-4">
        <Typography className="text-lg font-semibold text-foreground">{title}</Typography>
        {onMore ? (
          <TvPressable focusBorderRadius={6} focusScale={1.04} style={{ padding: 4 }} onPress={onMore}>
            <Typography className="text-sm text-accent">查看全部</Typography>
          </TvPressable>
        ) : null}
      </View>
      <MediaGrid items={visible} padded={false} onOpen={onOpen} />
    </View>
  );
}

export function MediaGrid({
  items,
  padded = false,
  onOpen,
}: {
  items: MediaItem[];
  padded?: boolean;
  onOpen: (id: string) => void;
}) {
  const tileWidth = usePosterTileWidth();
  return (
    <View className={`flex-row flex-wrap ${padded ? 'px-5' : ''}`} style={{ columnGap: GRID_GAP, rowGap: 28 }}>
      {items.map((item) => (
        <MediaTile key={item.Id} item={item} width={tileWidth} onPress={() => { onOpen(item.Id); }} />
      ))}
    </View>
  );
}

export function PosterGridSkeleton({ count = 6 }: { count?: number }) {
  const tileWidth = usePosterTileWidth();
  return (
    <View className="flex-row flex-wrap px-5" style={{ columnGap: GRID_GAP, rowGap: 28 }}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          className="rounded-xl"
          key={index}
          style={{ aspectRatio: 2 / 3, borderRadius: 12, width: tileWidth }}
        />
      ))}
    </View>
  );
}
