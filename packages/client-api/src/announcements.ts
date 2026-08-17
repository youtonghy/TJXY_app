import { clientRequest, type ClientSession } from './http';

export type AnnouncementKind = 'Popup' | 'Standard';

export interface ClientAnnouncement {
  id: string;
  title: string;
  bodyMarkdown: string;
  kind: AnnouncementKind;
  contentVersion: number;
  publishedAt: string;
  isRead: boolean;
}

export interface ClientAnnouncementPage {
  items: ClientAnnouncement[];
  total: number;
  unreadCount: number;
}

interface RawAnnouncement {
  Id?: string;
  Title?: string;
  BodyMarkdown?: string;
  Kind?: string;
  ContentVersion?: number;
  PublishedAt?: string;
  IsRead?: boolean;
}

function mapAnnouncement(value: RawAnnouncement): ClientAnnouncement | undefined {
  if (!value.Id || !value.Title || !value.BodyMarkdown || !value.PublishedAt) return undefined;
  if (value.Kind !== 'Popup' && value.Kind !== 'Standard') return undefined;
  return {
    id: value.Id,
    title: value.Title,
    bodyMarkdown: value.BodyMarkdown,
    kind: value.Kind,
    contentVersion: value.ContentVersion ?? 1,
    publishedAt: value.PublishedAt,
    isRead: value.IsRead === true,
  };
}

export async function getAnnouncements(
  session: ClientSession,
  request: { startIndex?: number; limit?: number } = {},
): Promise<ClientAnnouncementPage> {
  const query = new URLSearchParams({
    startIndex: String(request.startIndex ?? 0),
    limit: String(request.limit ?? 50),
  });
  const value = await clientRequest<{
    Items?: RawAnnouncement[];
    Total?: number;
    UnreadCount?: number;
  }>(session, `/Announcements?${query}`);
  return {
    items: (value.Items ?? []).flatMap((item) => {
      const mapped = mapAnnouncement(item);
      return mapped ? [mapped] : [];
    }),
    total: value.Total ?? 0,
    unreadCount: value.UnreadCount ?? 0,
  };
}

export async function getNextPopupAnnouncement(session: ClientSession): Promise<ClientAnnouncement | null> {
  const value = await clientRequest<RawAnnouncement | undefined>(session, '/Announcements/NextPopup');
  if (!value) return null;
  return mapAnnouncement(value) ?? null;
}

export async function acknowledgeAnnouncement(
  session: ClientSession,
  id: string,
  contentVersion: number,
): Promise<void> {
  await clientRequest(session, `/Announcements/${encodeURIComponent(id)}/Acknowledge`, {
    method: 'POST',
    body: JSON.stringify({ ContentVersion: contentVersion }),
  });
}
