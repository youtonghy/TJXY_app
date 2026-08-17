import { Typography } from 'heroui-native';
import { useThemeColor } from 'heroui-native/hooks';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppToolbar } from './AppToolbar';
import { BrandMark } from './branding';
import { useColorMode } from '../theme';
import { TvButton as Button } from './TvButton';

export function Page({
  back = false,
  children,
  padded = true,
  scroll = true,
  toolbar = true,
}: {
  back?: boolean;
  children: ReactNode;
  padded?: boolean;
  scroll?: boolean;
  toolbar?: boolean;
}) {
  const background = useThemeColor('background');
  const surface = useThemeColor('surface');
  const router = useRouter();
  const { density } = useColorMode();
  const horizontalPadding = density === 'compact' ? 16 : 20;

  return (
    <View className="flex-1 bg-background" style={{ backgroundColor: background, flex: 1 }}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        {toolbar || back ? (
          <View
            className="flex-row items-center justify-between border-b border-border py-2"
            style={{ backgroundColor: surface, paddingHorizontal: horizontalPadding }}
          >
            {back ? (
              <Button size="sm" variant="ghost" onPress={() => { router.back(); }}>
                <Button.Label>返回</Button.Label>
              </Button>
            ) : (
              <BrandMark compact />
            )}
            {toolbar ? <View className="shrink-0"><AppToolbar /></View> : <View />}
          </View>
        ) : null}
        {scroll ? (
          <ScrollView
            contentContainerStyle={{
              flexGrow: 1,
              gap: padded ? (density === 'compact' ? 20 : 24) : 32,
              paddingBottom: 48,
              paddingHorizontal: padded ? horizontalPadding : 0,
              paddingTop: density === 'compact' ? 20 : 24,
            }}
            nestedScrollEnabled
            style={{ flex: 1 }}
          >
            {children}
          </ScrollView>
        ) : (
          <View style={{ flex: 1, paddingHorizontal: padded ? horizontalPadding : 0 }}>{children}</View>
        )}
      </SafeAreaView>
    </View>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <View className="gap-1">
      {eyebrow ? <Typography className="text-sm font-medium text-accent">{eyebrow}</Typography> : null}
      <Typography.Heading className="text-3xl font-semibold tracking-tight text-foreground">{title}</Typography.Heading>
      {description ? <Typography.Paragraph className="max-w-xl text-muted">{description}</Typography.Paragraph> : null}
    </View>
  );
}
