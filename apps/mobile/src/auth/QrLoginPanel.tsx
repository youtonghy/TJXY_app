import { Alert, Card, Spinner, Typography } from 'heroui-native';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { createQrChallenge, pollQrChallenge, type QrChallenge } from '@tjxy/client-api';
import { useClient, useSession } from '../session';
import { TvButton as Button } from '../ui/TvButton';

export function QrLoginPanel() {
  const client = useClient();
  const { adoptAuthentication } = useSession();
  const [challenge, setChallenge] = useState<QrChallenge>();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const next = await createQrChallenge(client);
      setChallenge(next);
      setSecondsLeft(Math.max(0, Math.ceil((Date.parse(next.ExpiresAt) - Date.now()) / 1000)));
    } catch {
      setChallenge(undefined);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!challenge) return undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const result = await pollQrChallenge(client, challenge.ChallengeId, challenge.PollToken, controller.signal);
        const accessToken = result.Authentication?.AccessToken;
        if (accessToken) await adoptAuthentication(accessToken);
      } catch {
        if (!controller.signal.aborted && Date.parse(challenge.ExpiresAt) <= Date.now()) setError(true);
      }
    };
    void poll();
    const pollTimer = setInterval(() => { void poll(); }, 2_000);
    const countdownTimer = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((Date.parse(challenge.ExpiresAt) - Date.now()) / 1000)));
    }, 1_000);
    return () => {
      controller.abort();
      clearInterval(pollTimer);
      clearInterval(countdownTimer);
    };
  }, [adoptAuthentication, challenge, client]);

  return (
    <View className="gap-4">
      <Card variant="secondary">
        <Card.Body className="items-center gap-4 p-5">
          {loading ? <Spinner /> : challenge ? (
            <View className="rounded-lg bg-white p-3">
              <QRCode value={challenge.QrPayload} size={220} backgroundColor="#ffffff" color="#000000" />
            </View>
          ) : null}
          <Typography className="text-center text-sm text-muted">
            {secondsLeft > 0 ? `请使用另一台已登录设备扫码，${secondsLeft} 秒后过期。` : '二维码已过期。'}
          </Typography>
        </Card.Body>
        <Card.Footer>
          <Button className="w-full" isDisabled={loading} variant="secondary" onPress={() => { void refresh(); }}>
            <Button.Label>刷新二维码</Button.Label>
          </Button>
        </Card.Footer>
      </Card>
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>二维码登录不可用</Alert.Title>
            <Alert.Description>请确认服务器已经更新，然后重试。</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </View>
  );
}
