import { Image } from 'expo-image';
import { imagePath, resolveApiUrl, type MediaItem } from '@tjxy/client-api';
import { useClient } from './session';

export const POSTER_WIDTH = 128;
export const POSTER_HEIGHT = 192;

export function Poster({
  fill = false,
  height = POSTER_HEIGHT,
  item,
  width = POSTER_WIDTH,
}: {
  fill?: boolean;
  height?: number;
  item: MediaItem;
  width?: number;
}) {
  const client = useClient();
  const path = imagePath(item);
  const aspectRatio = item.Type === 'Audio' ? 1 : 2 / 3;
  const style = fill
    ? { width: '100%' as const, aspectRatio }
    : { width, height };
  const source = path && client.token
    ? {
        uri: resolveApiUrl(path, client.baseUrl),
        headers: {
          'X-Emby-Token': client.token,
        },
      }
    : undefined;

  return (
    <Image
      className="bg-default"
      cachePolicy="memory-disk"
      contentFit="cover"
      onError={({ error }) => {
        console.warn(`Poster failed to load for item ${item.Id}: ${error}`);
      }}
      source={source}
      style={style}
    />
  );
}
