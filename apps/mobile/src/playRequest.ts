import type WebView from 'react-native-webview';
import type { BridgeSession } from './bridgeSession';

export type NativePlaySession = Pick<BridgeSession, 'serverOrigin' | 'deviceId'> & { accessToken: string };

export interface NativePlayRequest {
  itemId: string;
  libraryId?: string;
  session: NativePlaySession;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function parseNativePlayRequest(payload: unknown): NativePlayRequest | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const session = (record.session && typeof record.session === 'object' ? record.session : {}) as Record<string, unknown>;
  const itemId = nonEmptyString(record.itemId);
  const serverOrigin = nonEmptyString(session.serverOrigin);
  const accessToken = nonEmptyString(session.accessToken);
  const deviceId = nonEmptyString(session.deviceId);
  if (!itemId || !serverOrigin || !accessToken || !deviceId) return undefined;
  return {
    itemId,
    libraryId: nonEmptyString(record.libraryId),
    session: { serverOrigin, accessToken, deviceId },
  };
}

let pending: NativePlayRequest | undefined;

export function setPendingPlayRequest(request: NativePlayRequest): void {
  pending = request;
}

export function takePendingPlayRequest(): NativePlayRequest | undefined {
  const request = pending;
  pending = undefined;
  return request;
}

let webView: WebView | null = null;

export function registerWebView(instance: WebView | null): void {
  webView = instance;
}

export function postToWeb(message: Record<string, unknown>): void {
  webView?.postMessage(JSON.stringify(message));
}
