import { Asset } from 'expo-asset';
import { fetch as expoFetch } from 'expo/fetch';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import { Alert, Spinner } from 'heroui-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { useBridgeSession } from '../src/bridgeSession';
import { parseNativePlayRequest, postToWeb, registerWebView, setPendingPlayRequest } from '../src/playRequest';
import { BRIDGE_SCRIPT } from '../src/webBridgeScript';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webBundleAsset = require('../assets/web/app.html') as number;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHUNK_BYTES = 192 * 1024;
const PLAY_DEBOUNCE_MS = 1000;

function toBase64(bytes: Uint8Array): string {
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!;
    const b = bytes[offset + 1];
    const c = bytes[offset + 2];
    output += BASE64_ALPHABET[a >> 2];
    output += BASE64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    output += b === undefined ? '=' : BASE64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    output += c === undefined ? '=' : BASE64_ALPHABET[c & 0x3f];
  }
  return output;
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const clean = value.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let out = 0;
  for (let offset = 0; offset + 3 < clean.length; offset += 4) {
    const a = BASE64_ALPHABET.indexOf(clean[offset]!);
    const b = BASE64_ALPHABET.indexOf(clean[offset + 1]!);
    const c = BASE64_ALPHABET.indexOf(clean[offset + 2]!);
    const d = BASE64_ALPHABET.indexOf(clean[offset + 3]!);
    bytes[out++] = (a << 2) | (b >> 4);
    bytes[out++] = ((b & 0x0f) << 4) | (c >> 2);
    bytes[out++] = ((c & 0x03) << 6) | d;
  }
  const rem = clean.length % 4;
  if (rem === 2) {
    const a = BASE64_ALPHABET.indexOf(clean[clean.length - 2]!);
    const b = BASE64_ALPHABET.indexOf(clean[clean.length - 1]!);
    bytes[out++] = (a << 2) | (b >> 4);
  } else if (rem === 3) {
    const a = BASE64_ALPHABET.indexOf(clean[clean.length - 3]!);
    const b = BASE64_ALPHABET.indexOf(clean[clean.length - 2]!);
    const c = BASE64_ALPHABET.indexOf(clean[clean.length - 1]!);
    bytes[out++] = (a << 2) | (b >> 4);
    bytes[out++] = ((b & 0x0f) << 4) | (c >> 2);
  }
  return bytes.subarray(0, out);
}

interface FetchMessage {
  kind: 'tjxy-fetch' | 'tjxy-fetch-abort';
  id: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  bodyBase64?: string;
}

export default function WebHomeScreen() {
  const router = useRouter();
  const { setSession } = useBridgeSession();
  const webRef = useRef<WebView>(null);
  const fetchControllers = useRef(new Map<string, AbortController>());
  const lastPlayAt = useRef(0);
  const [html, setHtml] = useState<string>();
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const asset = Asset.fromModule(webBundleAsset);
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        const content = await FileSystem.readAsStringAsync(uri);
        if (active) setHtml(content);
      } catch {
        if (active) setLoadError(true);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    registerWebView(webRef.current);
    return () => {
      registerWebView(null);
      for (const controller of fetchControllers.current.values()) controller.abort();
      fetchControllers.current.clear();
    };
  }, []);

  const handleFetch = useCallback(async (message: FetchMessage) => {
    const controller = new AbortController();
    fetchControllers.current.set(message.id, controller);
    try {
      const response = await expoFetch(message.url!, {
        method: message.method ?? 'GET',
        headers: message.headers,
        body: message.bodyBase64 ? fromBase64(message.bodyBase64) : (message.body ?? undefined),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'follow',
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      postToWeb({
        kind: 'tjxy-fetch', id: message.id, phase: 'headers',
        status: response.status, statusText: response.statusText, headers,
      });
      const body = response.body;
      if (!body) {
        postToWeb({ kind: 'tjxy-fetch', id: message.id, phase: 'end' });
        return;
      }
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) {
          postToWeb({
            kind: 'tjxy-fetch', id: message.id, phase: 'chunk',
            data: toBase64(value.subarray(offset, offset + CHUNK_BYTES)),
          });
        }
      }
      postToWeb({ kind: 'tjxy-fetch', id: message.id, phase: 'end' });
    } catch (error) {
      postToWeb({
        kind: 'tjxy-fetch', id: message.id, phase: 'error',
        message: error instanceof Error ? error.message : 'Request failed.',
      });
    } finally {
      fetchControllers.current.delete(message.id);
    }
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.nativeEvent.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.kind === 'tjxy-fetch') {
      void handleFetch(message as unknown as FetchMessage);
      return;
    }
    if (message.kind === 'tjxy-fetch-abort') {
      const controller = fetchControllers.current.get(String(message.id));
      controller?.abort();
      fetchControllers.current.delete(String(message.id));
      return;
    }
    switch (message.type) {
      case 'tjxy-native-play': {
        const request = parseNativePlayRequest(message.payload);
        if (!request) {
          console.warn('Ignoring tjxy-native-play without an item id or a signed-in session.');
          break;
        }
        const now = Date.now();
        if (now - lastPlayAt.current < PLAY_DEBOUNCE_MS) break;
        lastPlayAt.current = now;
        setPendingPlayRequest(request);
        router.push('/play');
        break;
      }
      case 'tjxy-session':
        setSession(message.payload as Parameters<typeof setSession>[0]);
        break;
      case 'tjxy-authorize':
        router.push('/authorize');
        break;
    }
  }, [handleFetch, router, setSession]);

  if (loadError) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-6">
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>界面资源缺失</Alert.Title>
            <Alert.Description>请先在仓库根目录运行 pnpm sync:frontend 生成应用内前端资源。</Alert.Description>
          </Alert.Content>
        </Alert>
      </SafeAreaView>
    );
  }
  if (!html) {
    return (
      <View className="flex-1 items-center justify-center bg-background" style={{ flex: 1 }}>
        <Spinner />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background" style={{ flex: 1 }}>
      <WebView
        allowsFullscreenVideo={false}
        allowsInlineMediaPlayback
        domStorageEnabled
        injectedJavaScriptBeforeContentLoaded={BRIDGE_SCRIPT}
        onMessage={onMessage}
        originWhitelist={['*']}
        ref={webRef}
        source={{ html, baseUrl: 'http://tjxy.app/' }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        onShouldStartLoadWithRequest={(request) => {
          if (request.url.startsWith('http://tjxy.app/') || request.url === 'about:blank') return true;
          void Linking.openURL(request.url);
          return false;
        }}
      />
    </View>
  );
}
