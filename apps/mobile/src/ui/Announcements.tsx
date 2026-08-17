import Ionicons from '@expo/vector-icons/Ionicons';
import { Alert, Chip, Dialog, Spinner, Typography } from 'heroui-native';
import { useThemeColor } from 'heroui-native/hooks';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import {
  acknowledgeAnnouncement,
  getAnnouncements,
  getNextPopupAnnouncement,
  type ClientAnnouncement,
} from '@tjxy/client-api';
import { formatDateTime } from '../labels';
import { useSession } from '../session';
import { TvButton as Button } from './TvButton';

function plainAnnouncementBody(markdown: string) {
  return markdown
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_#>`]/g, '')
    .trim();
}

interface AnnouncementsValue {
  items: ClientAnnouncement[];
  unreadCount: number;
  popup: ClientAnnouncement | null;
  loading: boolean;
  failed: boolean;
  pendingId: string | null;
  centerOpen: boolean;
  setCenterOpen: (open: boolean) => void;
  load: () => Promise<void>;
  acknowledge: (announcement: ClientAnnouncement, continuePopups: boolean) => Promise<void>;
}

const AnnouncementsContext = createContext<AnnouncementsValue | null>(null);

export function AnnouncementsProvider({ children }: { children: ReactNode }) {
  const { client, token } = useSession();
  const [items, setItems] = useState<ClientAnnouncement[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [popup, setPopup] = useState<ClientAnnouncement | null>(null);
  const [centerOpen, setCenterOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client || !token) {
      setItems([]);
      setUnreadCount(0);
      setPopup(null);
      setLoading(false);
      return;
    }
    try {
      const [page, nextPopup] = await Promise.all([
        getAnnouncements(client, { startIndex: 0, limit: 50 }),
        getNextPopupAnnouncement(client),
      ]);
      setItems(page.items);
      setUnreadCount(page.unreadCount);
      setPopup(nextPopup);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [client, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const acknowledge = useCallback(async (announcement: ClientAnnouncement, continuePopups: boolean) => {
    if (!client) return;
    setPendingId(announcement.id);
    try {
      await acknowledgeAnnouncement(client, announcement.id, announcement.contentVersion);
      const wasUnread = items.some((item) => item.id === announcement.id && !item.isRead);
      setItems((current) => current.map((item) => (
        item.id === announcement.id ? { ...item, isRead: true } : item
      )));
      if (wasUnread) setUnreadCount((current) => Math.max(0, current - 1));
      if (continuePopups) setPopup(await getNextPopupAnnouncement(client));
      else if (popup?.id === announcement.id) setPopup(null);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setPendingId(null);
    }
  }, [client, items, popup]);

  const value = useMemo<AnnouncementsValue>(() => ({
    items,
    unreadCount,
    popup,
    loading,
    failed,
    pendingId,
    centerOpen,
    setCenterOpen,
    load,
    acknowledge,
  }), [acknowledge, centerOpen, failed, items, load, loading, pendingId, popup, unreadCount]);

  return (
    <AnnouncementsContext.Provider value={value}>
      {children}
      <AnnouncementDialogs />
    </AnnouncementsContext.Provider>
  );
}

function useAnnouncements() {
  const value = useContext(AnnouncementsContext);
  if (!value) throw new Error('useAnnouncements must be used inside AnnouncementsProvider');
  return value;
}

export function AnnouncementsButton() {
  const foreground = useThemeColor('foreground');
  const { unreadCount, popup, setCenterOpen } = useAnnouncements();

  return (
    <View>
      <Button
        isDisabled={popup !== null}
        isIconOnly
        size="sm"
        variant="ghost"
        onPress={() => { setCenterOpen(true); }}
      >
        <Ionicons color={foreground} name="notifications-outline" size={18} />
      </Button>
      {unreadCount > 0 ? (
        <View className="absolute right-1 top-1 size-2 rounded-full bg-danger" />
      ) : null}
    </View>
  );
}

function AnnouncementDialogs() {
  const {
    items,
    popup,
    loading,
    failed,
    pendingId,
    centerOpen,
    setCenterOpen,
    load,
    acknowledge,
  } = useAnnouncements();

  return (
    <>
      <Dialog isOpen={centerOpen} onOpenChange={setCenterOpen}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Close variant="ghost" />
            <Dialog.Title>公告</Dialog.Title>
            {loading ? (
              <View className="items-center py-8"><Spinner /></View>
            ) : failed ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>公告加载失败</Alert.Title>
                </Alert.Content>
              </Alert>
            ) : items.length === 0 ? (
              <Dialog.Description>暂无已发布公告。</Dialog.Description>
            ) : (
              <View className="h-80">
                <ScrollView>
                  {items.map((item) => (
                    <View className="gap-2 border-b border-separator py-4" key={`${item.id}:${item.contentVersion}`}>
                      <View className="flex-row items-start justify-between gap-3">
                        <View className="min-w-0 flex-1">
                          <Typography className="font-semibold text-foreground">{item.title}</Typography>
                          <Typography className="text-xs text-muted">{formatDateTime(item.publishedAt)}</Typography>
                        </View>
                        <Chip color={item.isRead ? 'default' : 'danger'} size="sm" variant="soft">
                          <Chip.Label>{item.isRead ? '已读' : '未读'}</Chip.Label>
                        </Chip>
                      </View>
                      <Typography className="text-sm text-muted">{plainAnnouncementBody(item.bodyMarkdown)}</Typography>
                      {!item.isRead ? (
                        <Button
                          isDisabled={pendingId === item.id}
                          size="sm"
                          variant="secondary"
                          onPress={() => { void acknowledge(item, false); }}
                        >
                          <Button.Label>标记已读</Button.Label>
                        </Button>
                      ) : null}
                    </View>
                  ))}
                </ScrollView>
              </View>
            )}
            {failed && !loading ? (
              <Button className="mt-3" size="sm" variant="secondary" onPress={() => { void load(); }}>
                <Button.Label>重试</Button.Label>
              </Button>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog isOpen={popup !== null} onOpenChange={() => undefined}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content>
            <Dialog.Title>{popup?.title}</Dialog.Title>
            <Dialog.Description>
              {popup ? plainAnnouncementBody(popup.bodyMarkdown) : ''}
            </Dialog.Description>
            {failed ? (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>确认失败</Alert.Title>
                  <Alert.Description>请重试，确认成功后才能继续。</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            <Button
              className="mt-4"
              isDisabled={!popup || pendingId === popup.id}
              onPress={() => { if (popup) void acknowledge(popup, true); }}
            >
              <Button.Label>我已了解</Button.Label>
            </Button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </>
  );
}
