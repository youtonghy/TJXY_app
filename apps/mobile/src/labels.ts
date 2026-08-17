import type { MediaItem } from '@tjxy/client-api';

export function typeLabel(type?: string) {
  if (type === 'Movie') return '电影';
  if (type === 'Series') return '剧集';
  if (type === 'Episode') return '单集';
  if (type === 'Season') return '季';
  if (type === 'Audio') return '音频';
  return type ?? '影片';
}

export function personTypeLabel(type?: string) {
  if (type === 'Crew') return '幕后';
  if (type === 'Actor') return '演员';
  return type;
}

export function formatRuntime(ticks?: number) {
  if (!ticks || ticks <= 0) return undefined;
  const minutes = Math.round(ticks / 10_000_000 / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function formatDate(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date);
}

export function formatDateTime(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function sortByIndex(left: MediaItem, right: MediaItem) {
  return (left.IndexNumber ?? Number.MAX_SAFE_INTEGER) - (right.IndexNumber ?? Number.MAX_SAFE_INTEGER)
    || left.Name.localeCompare(right.Name, 'zh-CN');
}

export function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
