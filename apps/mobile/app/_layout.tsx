import '../global.css';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { HeroUINativeProvider, useThemeColor } from 'heroui-native';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Uniwind } from 'uniwind';
import { BridgeSessionProvider } from '../src/bridgeSession';

export function AppStack() {
  const background = useThemeColor('background');
  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: background }, headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="play" options={{ animation: 'fade' }} />
      <Stack.Screen name="authorize" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <HeroUINativeProvider>
          <BridgeSessionProvider>
            <View style={{ flex: 1 }}>
              <StatusBar style={Uniwind.currentTheme === 'dark' ? 'light' : 'dark'} />
              <AppStack />
            </View>
          </BridgeSessionProvider>
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
