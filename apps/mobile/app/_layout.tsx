import '../global.css';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HeroUINativeProvider, Spinner } from 'heroui-native';
import { SessionProvider, useSession } from '../src/session';
import { SiteSettingsProvider } from '../src/siteSettings';
import { ThemeProvider, useColorMode } from '../src/theme';
import { AnnouncementsProvider } from '../src/ui/Announcements';

function ThemedStatusBar() {
  const { mode } = useColorMode();
  return <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />;
}

function Guard() {
  const { ready, baseUrl, token } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const group = segments[0];
    const screen = (segments as string[])[1] ?? '';
    if (!baseUrl) {
      if (group !== '(auth)' || screen !== 'server') router.replace('/(auth)/server');
      return;
    }
    if (!token) {
      if (group !== '(auth)' || screen !== 'login') router.replace('/(auth)/login');
      return;
    }
    if (group === '(auth)') router.replace('/(tabs)');
  }, [baseUrl, ready, router, segments, token]);

  if (!ready) {
    return (
      <View className="flex-1 items-center justify-center bg-background" style={{ flex: 1 }}>
        <Spinner />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ contentStyle: { flex: 1 }, headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="libraries/[id]" />
      <Stack.Screen name="items/[id]" />
      <Stack.Screen name="play/[id]" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="authorize" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider style={{ flex: 1 }}>
        <HeroUINativeProvider config={{ devInfo: { stylingPrinciples: false } }}>
          <SessionProvider>
            <SiteSettingsProvider>
              <ThemeProvider>
                <ThemedStatusBar />
                <AnnouncementsProvider>
                  <Guard />
                </AnnouncementsProvider>
              </ThemeProvider>
            </SiteSettingsProvider>
          </SessionProvider>
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
