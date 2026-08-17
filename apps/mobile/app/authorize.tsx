import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { Alert, Card, Dialog, Input, Label, Spinner, TextField, Typography } from 'heroui-native';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  approvalTokenFromQrPayload,
  approveQrLogin,
  previewQrApproval,
  type QrApprovalPreview,
} from '@tjxy/client-api';
import { useClient } from '../src/session';
import { Page } from '../src/ui/Page';
import { TvButton as Button } from '../src/ui/TvButton';

export default function AuthorizeDeviceScreen() {
  const client = useClient();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [preview, setPreview] = useState<QrApprovalPreview>();
  const [approvalToken, setApprovalToken] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [pending, setPending] = useState(false);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState('');
  const [approved, setApproved] = useState(false);

  const inspect = useCallback(async (value: string) => {
    if (!scanning || pending) return;
    const token = approvalTokenFromQrPayload(value);
    if (!token) {
      setError('这不是 TJXY 登录二维码。');
      return;
    }
    setScanning(false);
    setPending(true);
    setError('');
    try {
      const next = await previewQrApproval(client, token);
      setApprovalToken(token);
      setPreview(next);
    } catch {
      setError('二维码无效或已过期。');
      setScanning(true);
    } finally {
      setPending(false);
    }
  }, [client, pending, scanning]);

  const onScanned = useCallback((result: BarcodeScanningResult) => {
    void inspect(result.data);
  }, [inspect]);

  async function approve() {
    if (!approvalToken || pending) return;
    setPending(true);
    setError('');
    try {
      await approveQrLogin(client, approvalToken);
      setPreview(undefined);
      setApproved(true);
    } catch {
      setError('无法批准此次登录，请重新扫描。');
      setPreview(undefined);
      setScanning(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <Page back>
      <View className="gap-1">
        <Typography className="text-2xl font-semibold text-foreground">授权其他设备</Typography>
        <Typography className="text-sm text-muted">扫描另一台设备登录页上的二维码，并确认设备信息。</Typography>
      </View>
      {approved ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>设备已授权</Alert.Title>
            <Alert.Description>其他设备现在可以完成登录。</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <Card>
          <Card.Body className="gap-4">
            {!permission?.granted ? (
              <View className="items-center gap-3 py-8">
                <Typography className="text-center text-sm text-muted">需要相机权限才能扫描登录二维码。</Typography>
                <Button onPress={() => { void requestPermission(); }}>
                  <Button.Label>允许使用相机</Button.Label>
                </Button>
              </View>
            ) : (
              <View className="overflow-hidden rounded-lg bg-black" style={styles.cameraFrame}>
                <CameraView
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  facing="back"
                  onBarcodeScanned={scanning ? onScanned : undefined}
                  style={StyleSheet.absoluteFill}
                />
              </View>
            )}
            <Typography className="text-center text-sm text-muted">
              {pending ? '正在读取二维码…' : '将二维码放入取景框内。'}
            </Typography>
            <TextField>
              <Label>或粘贴二维码内容</Label>
              <Input autoCapitalize="none" autoCorrect={false} value={manualCode} onChangeText={setManualCode} />
            </TextField>
            <Button
              isDisabled={!manualCode.trim() || pending}
              variant="secondary"
              onPress={() => { void inspect(manualCode); }}
            >
              <Button.Label>使用二维码内容</Button.Label>
            </Button>
          </Card.Body>
        </Card>
      )}
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content><Alert.Title>扫码失败</Alert.Title><Alert.Description>{error}</Alert.Description></Alert.Content>
        </Alert>
      ) : null}
      <Button variant="tertiary" onPress={() => { router.back(); }}>
        <Button.Label>返回个人中心</Button.Label>
      </Button>

      <Dialog isOpen={preview !== undefined} onOpenChange={(open) => {
        if (!open && !pending) {
          setPreview(undefined);
          setScanning(true);
        }
      }}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Close isDisabled={pending} />
            <View className="mb-5 gap-2">
              <Dialog.Title>确认登录</Dialog.Title>
              <Dialog.Description>确认让以下设备登录你的账户？</Dialog.Description>
              <Typography className="mt-2 font-semibold text-foreground">{preview?.DeviceName}</Typography>
              <Typography className="text-sm text-muted">
                {preview?.ClientName} · {preview?.ApplicationVersion}
              </Typography>
            </View>
            <View className="flex-row justify-end gap-3">
              <Button size="sm" variant="ghost" isDisabled={pending} onPress={() => {
                setPreview(undefined);
                setScanning(true);
              }}>
                <Button.Label>取消</Button.Label>
              </Button>
              <Button size="sm" isDisabled={pending} onPress={() => { void approve(); }}>
                {pending ? <Spinner /> : <Button.Label>批准登录</Button.Label>}
              </Button>
            </View>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </Page>
  );
}

const styles = StyleSheet.create({
  cameraFrame: { height: 320 },
});
