import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { useThemeColor } from 'heroui-native/hooks';
import { useEffect, useState } from 'react';
import { getAiModels } from '@tjxy/client-api';
import { useClient } from '../../src/session';

export default function TabsLayout() {
  const client = useClient();
  const [aiAvailable, setAiAvailable] = useState(true);
  const [background, accent, muted, separator] = useThemeColor([
    'background',
    'accent',
    'muted',
    'separator',
  ]);

  useEffect(() => {
    void getAiModels(client)
      .then((models) => { setAiAvailable(models.length > 0); })
      .catch(() => { setAiAvailable(false); });
  }, [client]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: muted,
        sceneStyle: { backgroundColor: background },
        tabBarStyle: {
          backgroundColor: background,
          borderTopColor: separator,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '首页',
          tabBarIcon: ({ color, size }) => <Ionicons color={color} name="home-outline" size={size} />,
        }}
      />
      <Tabs.Screen
        name="libraries"
        options={{
          title: '媒体库',
          tabBarIcon: ({ color, size }) => <Ionicons color={color} name="albums-outline" size={size} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: '搜索',
          tabBarIcon: ({ color, size }) => <Ionicons color={color} name="search-outline" size={size} />,
        }}
      />
      <Tabs.Screen
        name="rankings"
        options={{
          title: '排行榜',
          tabBarIcon: ({ color, size }) => <Ionicons color={color} name="trophy-outline" size={size} />,
        }}
      />
      <Tabs.Screen
        name="ai"
        options={{
          href: aiAvailable ? undefined : null,
          title: 'AI',
          tabBarIcon: ({ color, size }) => <Ionicons color={color} name="color-wand-outline" size={size} />,
        }}
      />
    </Tabs>
  );
}
