import Ionicons from '@expo/vector-icons/Ionicons';
import { useThemeColor } from 'heroui-native/hooks';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TvPressable } from './TvPressable';

export function Page({
  back = false,
  children,
  padded = true,
}: {
  back?: boolean;
  children: ReactNode;
  padded?: boolean;
}) {
  const background = useThemeColor('background');
  const foreground = useThemeColor('foreground');
  const router = useRouter();

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']} style={{ backgroundColor: background, flex: 1 }}>
      {back ? (
        <View className="px-5 pt-2 pb-1">
          <TvPressable
            accessibilityLabel="返回"
            className="size-11 items-center justify-center rounded-full"
            focusBorderRadius={22}
            onPress={() => { router.back(); }}
          >
            <Ionicons color={foreground} name="arrow-back" size={24} />
          </TvPressable>
        </View>
      ) : null}
      <ScrollView
        className="flex-1"
        contentContainerClassName={padded ? 'gap-4 px-5 pb-8' : 'pb-8'}
        style={{ flex: 1 }}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
