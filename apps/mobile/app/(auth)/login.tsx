import Ionicons from '@expo/vector-icons/Ionicons';
import { Alert, Checkbox, Input, Label, Spinner, TextField, Typography } from 'heroui-native';
import { useThemeColor } from 'heroui-native/hooks';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSession } from '../../src/session';
import { QrLoginPanel } from '../../src/auth/QrLoginPanel';
import { AuthFrame } from '../../src/ui/AuthFrame';
import { TvButton as Button } from '../../src/ui/TvButton';
import { TvPressable } from '../../src/ui/TvPressable';

export default function LoginScreen() {
  const { signIn, savedUsername, savedPassword } = useSession();
  const muted = useThemeColor('muted');
  const [username, setUsername] = useState(savedUsername);
  const [password, setPassword] = useState(savedPassword);
  const [remember, setRemember] = useState(true);
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<'password' | 'qr'>('password');

  useEffect(() => {
    if (savedUsername) setUsername(savedUsername);
    if (savedPassword) setPassword(savedPassword);
  }, [savedPassword, savedUsername]);

  async function submit() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await signIn(username, password, remember);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame subtitle="登录后继续观看。" title="欢迎回来">
      <View className="gap-4">
        <View className="flex-row gap-2" accessibilityRole="tablist">
          <Button
            className="flex-1"
            size="sm"
            variant={mode === 'password' ? 'primary' : 'secondary'}
            onPress={() => { setMode('password'); }}
          >
            <Button.Label>密码</Button.Label>
          </Button>
          <Button
            className="flex-1"
            size="sm"
            variant={mode === 'qr' ? 'primary' : 'secondary'}
            onPress={() => { setMode('qr'); }}
          >
            <Button.Label>二维码</Button.Label>
          </Button>
        </View>
        {mode === 'qr' ? <QrLoginPanel /> : (
          <>
        {failed ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>登录失败</Alert.Title>
              <Alert.Description>请检查用户名和密码。</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <TextField isRequired>
          <Label>用户名</Label>
          <Input autoCapitalize="none" autoCorrect={false} value={username} onChangeText={setUsername} />
        </TextField>
        <TextField isRequired>
          <Label>密码</Label>
          <View className="w-full flex-row items-center">
            <Input
              className="flex-1 pr-11"
              secureTextEntry={!visible}
              value={password}
              onChangeText={setPassword}
            />
            <TvPressable className="absolute right-3 p-1" focusBorderRadius={999} onPress={() => { setVisible((value) => !value); }}>
              <Ionicons color={muted} name={visible ? 'eye-off-outline' : 'eye-outline'} size={18} />
            </TvPressable>
          </View>
        </TextField>
        <TvPressable className="flex-row items-center gap-3 rounded-md p-1" focusBorderRadius={8} onPress={() => { setRemember((value) => !value); }}>
          <Checkbox isSelected={remember} onSelectedChange={setRemember}>
            <Checkbox.Indicator />
          </Checkbox>
          <Typography>保存用户名和密码</Typography>
        </TvPressable>
        <Button isDisabled={pending} onPress={() => { void submit(); }}>
          {pending ? <Spinner /> : <Button.Label pointerEvents="none">登录</Button.Label>}
        </Button>
          </>
        )}
      </View>
    </AuthFrame>
  );
}
