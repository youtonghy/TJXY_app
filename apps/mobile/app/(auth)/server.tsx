import { Alert, Description, Input, Label, Spinner, TextField } from 'heroui-native';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useSession } from '../../src/session';
import { AuthFrame } from '../../src/ui/AuthFrame';
import { TvButton as Button } from '../../src/ui/TvButton';

export default function ServerScreen() {
  const { saveServer, baseUrl } = useSession();
  const router = useRouter();
  const [value, setValue] = useState(baseUrl ?? 'http://127.0.0.1:8096');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function continueToLogin() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await saveServer(value);
      router.replace('/(auth)/login');
    } catch {
      setError('无法连接到该服务器。');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame subtitle="输入 TJXY 服务器地址后继续。" title="连接服务器">
      <View className="gap-4">
        <TextField isRequired>
          <Label>服务器地址</Label>
          <Input
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://127.0.0.1:8096"
            value={value}
            onChangeText={setValue}
          />
          <Description>模拟器可用 127.0.0.1，真机请填电脑的局域网 IP。</Description>
        </TextField>
        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>无法连接</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <Button isDisabled={pending || !value.trim()} onPress={() => { void continueToLogin(); }}>
          {pending ? <Spinner /> : <Button.Label pointerEvents="none">继续</Button.Label>}
        </Button>
      </View>
    </AuthFrame>
  );
}
