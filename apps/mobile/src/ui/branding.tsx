import { Typography } from 'heroui-native';
import { Image, View } from 'react-native';
import { useSiteSettings } from '../siteSettings';

export function BrandMark({
  compact = false,
  showSubtitle = false,
}: {
  compact?: boolean;
  showSubtitle?: boolean;
}) {
  const { branding: brand } = useSiteSettings();
  const size = compact ? 32 : 44;

  return (
    <View className={`min-w-0 flex-row items-center gap-3 ${compact ? 'flex-1' : ''}`}>
      {brand.logoUri ? (
        <Image
          resizeMode="contain"
          source={{ uri: brand.logoUri }}
          style={{ height: size, width: size }}
        />
      ) : (
        <View
          className="items-center justify-center rounded-lg bg-default"
          style={{ borderRadius: 8, height: size, width: size }}
        >
          <Typography className="font-semibold text-accent">TJ</Typography>
        </View>
      )}
      <View className="min-w-0 flex-1">
        <Typography className="font-semibold text-foreground" numberOfLines={1}>
          {brand.title}
        </Typography>
        {showSubtitle ? (
          <Typography className="text-sm text-muted" numberOfLines={1}>
            {brand.subtitle}
          </Typography>
        ) : null}
      </View>
    </View>
  );
}
