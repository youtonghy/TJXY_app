import { Surface, Typography } from 'heroui-native';
import { useThemeColor } from 'heroui-native/hooks';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColorMode } from '../theme';
import { BrandMark } from './branding';
import { TvButton as Button } from './TvButton';

export function AuthFrame({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle: string;
}) {
  const background = useThemeColor('background');
  const foreground = useThemeColor('foreground');
  const { mode, toggle } = useColorMode();

  return (
    <View className="flex-1 bg-background" style={{ backgroundColor: background, flex: 1 }}>
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView
            contentContainerStyle={{
              flexGrow: 1,
              justifyContent: 'center',
              paddingHorizontal: 20,
              paddingVertical: 40,
            }}
            keyboardShouldPersistTaps="handled"
            style={{ flex: 1 }}
          >
            <Surface
              className="relative w-full rounded-lg border border-border p-7"
              style={{ alignSelf: 'center', maxWidth: 460 }}
            >
              <View className="absolute right-5 top-5 z-10">
                <Button isIconOnly size="sm" variant="ghost" onPress={() => { toggle(); }}>
                  <Ionicons color={foreground} name={mode === 'dark' ? 'sunny-outline' : 'moon-outline'} size={18} />
                </Button>
              </View>
              <View className="mb-8 pr-12">
                <BrandMark showSubtitle />
              </View>
              <View className="mb-6 gap-1">
                <Typography className="text-2xl font-semibold text-foreground">{title}</Typography>
                <Typography className="text-sm text-muted">{subtitle}</Typography>
              </View>
              {children}
            </Surface>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
