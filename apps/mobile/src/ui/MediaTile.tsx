import Ionicons from '@expo/vector-icons/Ionicons';
import { Typography } from 'heroui-native';
import { useThemeColor } from 'heroui-native/hooks';
import { View } from 'react-native';
import type { MediaItem } from '@tjxy/client-api';
import { Poster } from '../Poster';
import { TvFocusFrame, TvPressable } from './TvPressable';

export function MediaTile({
  item,
  width,
  onPress,
}: {
  item: MediaItem;
  width: number;
  onPress: () => void;
}) {
  const accent = useThemeColor('accent');
  const progress = watchedProgress(item);
  const episodeCode = item.Type === 'Episode' && item.IndexNumber !== undefined
    ? `E${String(item.IndexNumber)}`
    : undefined;
  const facts = [
    episodeCode,
    item.ProductionYear ? String(item.ProductionYear) : undefined,
  ].filter(Boolean);

  return (
    <TvPressable focusScale={1.035} showFocusFrame={false} style={{ width }} onPress={onPress}>
      {(focused) => (
        <>
          <View className="relative overflow-hidden rounded-xl bg-default" style={{ borderRadius: 12 }}>
            <Poster fill item={item} />
            <View className="absolute right-2 top-2 flex-row items-center gap-1.5">
              {item.UserData?.IsFavorite ? (
                <View className="size-7 items-center justify-center rounded-full bg-background/90">
                  <Ionicons color="#f472b6" name="heart" size={16} />
                </View>
              ) : null}
              {item.UserData?.Played ? (
                <View className="size-7 items-center justify-center rounded-full bg-success">
                  <Ionicons color="#18181b" name="checkmark" size={16} />
                </View>
              ) : progress !== undefined ? (
                <View className="h-7 justify-center rounded-full bg-background/90 px-2">
                  <Typography className="text-[10px] tabular-nums text-foreground">{progress}%</Typography>
                </View>
              ) : null}
            </View>
            <TvFocusFrame visible={focused} />
          </View>
          <Typography
            className={`mt-2 text-sm font-medium ${focused ? 'text-blue-500' : 'text-foreground'}`}
            numberOfLines={1}
          >
            {item.Name}
          </Typography>
          <View className="mt-0.5 min-h-4 flex-row items-center gap-2">
            {facts.length > 0 ? (
              <Typography className="text-xs text-muted">{facts.join(' · ')}</Typography>
            ) : null}
            {item.CommunityRating !== undefined ? (
              <View className="flex-row items-center gap-0.5">
                <Ionicons color={accent} name="star" size={11} />
                <Typography className="text-xs tabular-nums text-muted">
                  {item.CommunityRating.toFixed(1)}
                </Typography>
              </View>
            ) : null}
          </View>
        </>
      )}
    </TvPressable>
  );
}

function watchedProgress(item: MediaItem): number | undefined {
  const position = item.UserData?.PlaybackPositionTicks ?? 0;
  const runtime = item.RunTimeTicks ?? 0;
  if (position <= 0 || runtime <= 0) return undefined;
  return Math.max(1, Math.min(99, Math.round((position / runtime) * 100)));
}
