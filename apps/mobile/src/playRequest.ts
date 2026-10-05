import type WebView from 'react-native-webview';

export interface PlayRequestSubtitle {
  key: string;
  label: string;
  url: string;
  language?: string;
  isDefault: boolean;
}

export interface PlayRequest {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  ticketId: string;
  streamUrl: string;
  title: string;
  serverOrigin: string;
  accessToken: string;
  deviceId: string;
  userId?: string;
  positionTicks: number;
  subtitles: PlayRequestSubtitle[];
}

let pending: PlayRequest | undefined;

export function setPendingPlayRequest(request: PlayRequest): void {
  pending = request;
}

export function takePendingPlayRequest(): PlayRequest | undefined {
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
