import {
  Alert,
  Avatar,
  Chip,
  Dialog,
  Input,
  Label,
  ListGroup,
  Separator,
  Switch,
  TextArea,
  TextField,
  Typography,
} from 'heroui-native';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { TvButton as Button } from '../src/ui/TvButton';
import { TvPressable } from '../src/ui/TvPressable';
import {
  getProfile,
  getUserInsights,
  listPersonalSessions,
  revokePersonalSession,
  updateProfile,
  type InsightRange,
  type InsightTimelineEvent,
  type UserInsights,
  type UserProfile,
  type PersonalSession,
} from '@tjxy/client-api';
import { formatDateTime, formatRuntime } from '../src/labels';
import { useClient, useSession } from '../src/session';
import { useColorMode } from '../src/theme';
import { Page } from '../src/ui/Page';
import { useRouter } from 'expo-router';

const ranges: { key: InsightRange; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: 'all', label: '全部时间' },
];

export default function ProfileScreen() {
  const client = useClient();
  const router = useRouter();
  const { user, baseUrl, saveServer, signOut } = useSession();
  const { mode, toggle } = useColorMode();
  const [profile, setProfile] = useState<UserProfile>();
  const [insights, setInsights] = useState<UserInsights>();
  const [range, setRange] = useState<InsightRange>('30d');
  const [editing, setEditing] = useState(false);
  const [server, setServer] = useState(baseUrl ?? '');
  const [message, setMessage] = useState<'ok' | 'error'>();
  const [pending, setPending] = useState(false);
  const [sessions, setSessions] = useState<PersonalSession[]>([]);
  const [sessionsFailed, setSessionsFailed] = useState(false);
  const [revokingSessionId, setRevokingSessionId] = useState<string>();

  useEffect(() => {
    void getProfile(client).then(setProfile).catch(() => undefined);
  }, [client]);
  useEffect(() => {
    void getUserInsights(client, range).then(setInsights).catch(() => { setInsights(undefined); });
  }, [client, range]);
  useEffect(() => {
    void listPersonalSessions(client)
      .then((value) => { setSessions(value); setSessionsFailed(false); })
      .catch(() => { setSessionsFailed(true); });
  }, [client]);

  return (
    <Page back>
      <View className="flex-row items-center gap-4 rounded-lg border border-border bg-surface p-5">
        <Avatar color="accent" size="lg">
          <Avatar.Fallback>{(profile?.Username ?? user?.Name ?? 'U').slice(0, 1).toUpperCase()}</Avatar.Fallback>
        </Avatar>
        <View className="min-w-0 flex-1 gap-1">
          <Typography className="text-sm font-medium text-accent">你的账户</Typography>
          <Typography className="text-3xl font-semibold text-foreground">
            {profile?.Username ?? user?.Name ?? '账户'}
          </Typography>
          <Typography className="text-sm leading-6 text-muted">
            {profile?.Bio || '添加一段简短的自我介绍。'}
          </Typography>
        </View>
      </View>
      {profile ? (
        <Button variant="secondary" onPress={() => { setEditing(true); }}>
          <Button.Label>编辑个人资料</Button.Label>
        </Button>
      ) : null}

      <View className="gap-3">
        <Typography className="text-xl font-semibold text-foreground">观看统计</Typography>
        <Typography className="text-sm text-muted">所选时间范围内的观看活动。</Typography>
        <View className="flex-row flex-wrap gap-2">
          {ranges.map((item) => (
            <Chip
              key={item.key}
              size="sm"
              variant={range === item.key ? 'primary' : 'soft'}
              onPress={() => { setRange(item.key); }}
            >
              <Chip.Label>{item.label}</Chip.Label>
            </Chip>
          ))}
        </View>
      </View>
      {insights ? (
        <>
          <View className="flex-row flex-wrap gap-3">
            <StatTile label="观看时长" value={formatRuntime(insights.WatchedTicks) ?? '0 分钟'} />
            <StatTile label="播放次数" value={String(insights.PlayCount)} />
            <StatTile label="观看内容数" value={String(insights.UniqueTitles)} />
            <StatTile label="最常看类型" value={insights.Genres?.[0]?.Name ?? '暂无活动'} />
            <StatTile label="电影播放" value={String(insights.Media?.Movies ?? 0)} />
            <StatTile label="剧集播放" value={String(insights.Media?.Series ?? 0)} />
          </View>
          {(insights.Genres?.length ?? 0) > 0 ? (
            <ListGroup>
              {(insights.Genres ?? []).slice(0, 6).map((genre, index) => (
                <View key={genre.Name}>
                  {index > 0 ? <Separator className="mx-4" /> : null}
                  <ListGroup.Item>
                    <ListGroup.ItemContent>
                      <ListGroup.ItemTitle>{genre.Name}</ListGroup.ItemTitle>
                      <ListGroup.ItemDescription>{formatRuntime(genre.WatchedTicks) ?? '0 分钟'}</ListGroup.ItemDescription>
                    </ListGroup.ItemContent>
                  </ListGroup.Item>
                </View>
              ))}
            </ListGroup>
          ) : null}
          <View className="gap-3">
            <Typography className="font-semibold text-foreground">观影时间线</Typography>
            {(insights.Timeline ?? []).length === 0 ? (
              <Typography className="text-sm text-muted">此时间范围内暂无观影节点。</Typography>
            ) : (insights.Timeline ?? []).map((event) => (
              <TimelineRow
                event={event}
                key={`${event.Kind}-${event.ItemId}-${event.At}`}
                onOpen={() => { router.push(`/items/${event.ItemId}`); }}
              />
            ))}
          </View>
        </>
      ) : null}

      <View className="gap-3">
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1 gap-1">
            <Typography className="text-xl font-semibold text-foreground">当前登录设备</Typography>
            <Typography className="text-sm text-muted">查看最近活动，并注销不再使用的登录。</Typography>
          </View>
          <Button size="sm" variant="secondary" onPress={() => { router.push('/authorize'); }}>
            <Button.Label>扫码授权</Button.Label>
          </Button>
        </View>
        {sessionsFailed ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content><Alert.Title>无法加载登录设备</Alert.Title></Alert.Content>
          </Alert>
        ) : null}
        <ListGroup>
          {sessions.map((session, index) => (
            <View key={session.Id}>
              {index > 0 ? <Separator className="mx-4" /> : null}
              <ListGroup.Item>
                <ListGroup.ItemContent>
                  <ListGroup.ItemTitle>
                    {session.DeviceName}{session.IsCurrent ? '（当前设备）' : ''}
                  </ListGroup.ItemTitle>
                  <ListGroup.ItemDescription>
                    {session.ClientName} · 最近活动 {formatDateTime(session.LastActivityDate)}
                  </ListGroup.ItemDescription>
                </ListGroup.ItemContent>
                <ListGroup.ItemSuffix>
                  <Button
                    isDisabled={revokingSessionId !== undefined}
                    size="sm"
                    variant="danger-soft"
                    onPress={() => {
                      setRevokingSessionId(session.Id);
                      void revokePersonalSession(client, session.Id)
                        .then(() => {
                          if (session.IsCurrent) {
                            void signOut();
                          } else {
                            setSessions((current) => current.filter((item) => item.Id !== session.Id));
                          }
                        })
                        .catch(() => { setSessionsFailed(true); })
                        .finally(() => { setRevokingSessionId(undefined); });
                    }}
                  >
                    <Button.Label>{revokingSessionId === session.Id ? '正在注销…' : '注销'}</Button.Label>
                  </Button>
                </ListGroup.ItemSuffix>
              </ListGroup.Item>
            </View>
          ))}
        </ListGroup>
      </View>

      <ListGroup>
        <ListGroup.Item>
          <ListGroup.ItemContent>
            <ListGroup.ItemTitle>深色模式</ListGroup.ItemTitle>
            <ListGroup.ItemDescription>{mode === 'dark' ? '夜间外观' : '日间外观'}</ListGroup.ItemDescription>
          </ListGroup.ItemContent>
          <ListGroup.ItemSuffix>
            <Switch isSelected={mode === 'dark'} onSelectedChange={() => { toggle(); }} />
          </ListGroup.ItemSuffix>
        </ListGroup.Item>
      </ListGroup>
      <View className="gap-3">
        <Typography className="font-semibold text-foreground">服务器</Typography>
        <Typography className="text-sm text-muted">更改服务器地址会退出当前登录。</Typography>
        <TextField>
          <Label>服务器地址</Label>
          <Input autoCapitalize="none" autoCorrect={false} value={server} onChangeText={setServer} />
        </TextField>
        {message === 'error' ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>无法连接到该服务器</Alert.Title>
              <Alert.Description>请检查地址后重试。</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        {message === 'ok' ? (
          <Alert status="success">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>服务器可访问</Alert.Title>
            </Alert.Content>
          </Alert>
        ) : null}
        <Button
          isDisabled={pending}
          variant="secondary"
          onPress={() => {
            setPending(true);
            setMessage(undefined);
            void saveServer(server)
              .then(() => { setMessage('ok'); })
              .catch(() => { setMessage('error'); })
              .finally(() => { setPending(false); });
          }}
        >
          <Button.Label>保存服务器</Button.Label>
        </Button>
      </View>
      <Separator />
      <Button variant="danger" onPress={() => { void signOut(); }}>
        <Button.Label>退出登录</Button.Label>
      </Button>
      {profile ? (
        <ProfileDialog
          isOpen={editing}
          profile={profile}
          onClose={() => { setEditing(false); }}
          onSaved={setProfile}
          onSessionInvalidated={() => { void signOut(); }}
        />
      ) : null}
    </Page>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <View
      className="gap-1 rounded-lg border border-border bg-surface p-4"
      style={{ flexBasis: '47%', flexGrow: 1, minWidth: 150 }}
    >
      <Typography className="text-xl font-semibold tabular-nums text-foreground" numberOfLines={1}>
        {value}
      </Typography>
      <Typography className="text-xs text-muted">{label}</Typography>
    </View>
  );
}

function TimelineRow({ event, onOpen }: { event: InsightTimelineEvent; onOpen: () => void }) {
  const prefix = event.Kind === 'SeriesCompleted' ? '看完了' : event.Kind === 'SeriesStarted' ? '开始看' : '看了';
  return (
    <TvPressable focusBorderRadius={8} onPress={onOpen}>
      <View className="gap-1 rounded-md bg-surface p-4">
        <Typography className="text-sm text-foreground">{prefix} {event.Name}</Typography>
        <Typography className="text-xs text-muted">{formatDateTime(event.At)}</Typography>
      </View>
    </TvPressable>
  );
}

function ProfileDialog({
  isOpen,
  profile,
  onClose,
  onSaved,
  onSessionInvalidated,
}: {
  isOpen: boolean;
  profile: UserProfile;
  onClose: () => void;
  onSaved: (profile: UserProfile) => void;
  onSessionInvalidated: () => void;
}) {
  const client = useClient();
  const [username, setUsername] = useState(profile.Username);
  const [bio, setBio] = useState(profile.Bio);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setUsername(profile.Username);
    setBio(profile.Bio);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
  }, [isOpen, profile]);

  async function submit() {
    if (pending || (newPassword && newPassword !== confirmPassword) || !currentPassword.trim()) return;
    setPending(true);
    setError('');
    try {
      const updated = await updateProfile(client, {
        Bio: bio.trim(),
        CurrentPassword: currentPassword,
        NewPassword: newPassword || undefined,
        Username: username.trim(),
      });
      onSaved(updated);
      onClose();
      if (newPassword || username.trim() !== profile.Username) onSessionInvalidated();
    } catch {
      setError('无法更新此账户。');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Dialog.Content>
            <Dialog.Close isDisabled={pending} variant="ghost" />
            <Dialog.Title>编辑账户</Dialog.Title>
            <View className="gap-4">
              <TextField>
                <Label>用户名</Label>
                <Input autoCapitalize="none" value={username} onChangeText={setUsername} />
              </TextField>
              <TextField>
                <Label>个人简介</Label>
                <TextArea value={bio} onChangeText={setBio} />
              </TextField>
              <Typography className="font-medium text-foreground">安全确认</Typography>
              <TextField>
                <Label>当前密码</Label>
                <Input secureTextEntry value={currentPassword} onChangeText={setCurrentPassword} />
              </TextField>
              <TextField>
                <Label>新密码</Label>
                <Input secureTextEntry value={newPassword} onChangeText={setNewPassword} />
              </TextField>
              <TextField>
                <Label>确认新密码</Label>
                <Input secureTextEntry value={confirmPassword} onChangeText={setConfirmPassword} />
              </TextField>
              {newPassword && confirmPassword && confirmPassword !== newPassword ? (
                <Typography className="text-sm text-danger">两次输入的新密码不一致。</Typography>
              ) : null}
              {error ? <Typography className="text-sm text-danger">{error}</Typography> : null}
              <View className="flex-row justify-end gap-3">
                <Button isDisabled={pending} size="sm" variant="tertiary" onPress={onClose}>
                  <Button.Label>取消</Button.Label>
                </Button>
                <Button isDisabled={pending || !currentPassword.trim()} size="sm" onPress={() => { void submit(); }}>
                  <Button.Label>保存更改</Button.Label>
                </Button>
              </View>
            </View>
          </Dialog.Content>
        </KeyboardAvoidingView>
      </Dialog.Portal>
    </Dialog>
  );
}
