import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar } from 'heroui-native';
import { useThemeColor } from 'heroui-native/hooks';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AnnouncementsButton } from './Announcements';
import { useSession } from '../session';
import { useColorMode } from '../theme';
import { TvButton as Button } from './TvButton';

export function AppToolbar() {
  const { mode, toggle } = useColorMode();
  const { user } = useSession();
  const router = useRouter();
  const foreground = useThemeColor('foreground');

  return (
    <View className="flex-row items-center justify-end gap-1">
      <AnnouncementsButton />
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        onPress={() => { toggle(); }}
      >
        <Ionicons
          color={foreground}
          name={mode === 'dark' ? 'sunny-outline' : 'moon-outline'}
          size={18}
        />
      </Button>
      <Button isIconOnly size="sm" variant="ghost" onPress={() => { router.push('/profile'); }}>
        <Avatar color="accent" size="sm" style={{ borderRadius: 999 }}>
          <Avatar.Fallback>{(user?.Name ?? 'U').slice(0, 1).toUpperCase()}</Avatar.Fallback>
        </Avatar>
      </Button>
    </View>
  );
}
