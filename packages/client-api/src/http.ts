import { isAbortError } from './ids.ts';

export type ClientErrorKind =
  | 'network'
  | 'authentication'
  | 'authorization'
  | 'not-found'
  | 'validation'
  | 'rate-limit'
  | 'unavailable'
  | 'invalid-response'
  | 'unexpected';

export class ClientApiError extends Error {
  status: number;
  kind: ClientErrorKind;
  constructor(status: number, kind: ClientErrorKind) {
    super(
      kind === 'authentication'
        ? 'Please sign in again.'
        : kind === 'authorization'
          ? 'You do not have access to this content.'
          : kind === 'not-found'
            ? 'This content is no longer available.'
            : kind === 'rate-limit'
              ? 'The request limit has been reached.'
            : 'The request could not be completed.',
    );
    this.name = 'ClientApiError';
    this.status = status;
    this.kind = kind;
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientSession {
  baseUrl: string;
  token: string | null;
  deviceId: string;
  clientName: string;
  deviceName: string;
  fetch?: FetchFn;
  eventStreamMode?: 'buffered' | 'streaming';
}

export function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('empty origin');
  const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid origin');
  return `${url.protocol}//${url.host}`;
}

export function resolveApiUrl(path: string, baseUrl: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('invalid path');
  if (!baseUrl) throw new Error('missing api base url');
  return new URL(path, `${baseUrl}/`).toString();
}

export function identityHeader(session: ClientSession): string {
  return `MediaBrowser Client="${session.clientName}", Device="${session.deviceName}", DeviceId="${session.deviceId}", Version="0.1.0"`;
}

export async function clientFetch(session: ClientSession, path: string, options: RequestInit = {}): Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new ClientApiError(0, 'validation');
  const headers = new Headers(options.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (session.token) headers.set('Authorization', `MediaBrowser Token="${session.token}"`);
  else headers.set('Authorization', identityHeader(session));
  if (options.body !== undefined && options.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => { headerRecord[key] = value; });
  const fetchImpl = session.fetch ?? fetch;
  try {
    return await fetchImpl(resolveApiUrl(path, session.baseUrl), {
      ...options,
      headers: headerRecord,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ClientApiError(0, 'network');
  }
}

export async function clientRequest<T>(session: ClientSession, path: string, options: RequestInit = {}): Promise<T> {
  const response = await clientFetch(session, path, options);
  if (!response.ok) throw new ClientApiError(response.status, clientErrorKind(response.status));
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!contentType?.includes('json')) throw new ClientApiError(response.status, 'invalid-response');
  return await response.json() as T;
}

export async function clientBlob(session: ClientSession, path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await clientFetch(session, path, { signal });
  if (!response.ok) throw new ClientApiError(response.status, clientErrorKind(response.status));
  return response.blob();
}

export async function probeServer(origin: string, signal?: AbortSignal): Promise<string> {
  const base = normalizeOrigin(origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const combined = signal ?? controller.signal;
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    for (const path of ['/System/Info/Public', '/health/ready', '/health/live']) {
      try {
        const response = await fetch(resolveApiUrl(path, base), { method: 'GET', signal: combined });
        if (response.ok) return base;
      } catch {
        if (combined.aborted) break;
      }
    }
    throw new ClientApiError(0, 'network');
  } finally {
    clearTimeout(timer);
  }
}

export function clientErrorKind(status: number): ClientErrorKind {
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not-found';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'unavailable';
  return 'unexpected';
}
