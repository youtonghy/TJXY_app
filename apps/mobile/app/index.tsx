import { Asset } from 'expo-asset';
import { fetch as expoFetch } from 'expo/fetch';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { useFocusEffect, useRouter } from 'expo-router';
import { Alert, Spinner, Typography } from 'heroui-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert as NativeAlert, BackHandler, Linking, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { BRIDGE_SESSION_KEY, useBridgeSession, type BridgeSession } from '../src/bridgeSession';
import { parseNativePlayRequest, postToWeb, registerWebView, setPendingPlayRequest } from '../src/playRequest';
import { BRIDGE_SCRIPT } from '../src/webBridgeScript';
import { TvButton as Button } from '../src/ui/TvButton';

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
  const [htmlUri, setHtmlUri] = useState<string>();
  const [readAccessUri, setReadAccessUri] = useState<string>();
  const [bootstrapScript, setBootstrapScript] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [webError, setWebError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const canGoBack = useRef(false);

  const attachWebView = useCallback((instance: WebView | null) => {
    webRef.current = instance;
    registerWebView(instance);
  }, []);

  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!webRef.current) return false;
      if (canGoBack.current) {
        webRef.current.goBack();
        return true;
      }
      if (!Platform.isTV) return false;
      // HashRouter navigation in a file WebView does not always update
      // WebView.canGoBack. Ask the page to go back before allowing Android to
      // close the activity.
      webRef.current.injectJavaScript(`(function(){if(location.hash && location.hash !== '#/app/' && history.length > 1){history.back();return;} window.ReactNativeWebView.postMessage(JSON.stringify({kind:'tjxy-tv-back'}));})();true;`);
      return true;
    });
    return () => subscription.remove();
  }, []));

  function retry() {
    for (const controller of fetchControllers.current.values()) controller.abort();
    fetchControllers.current.clear();
    canGoBack.current = false;
    setLoadError(false);
    setWebError(false);
    setHtmlUri(undefined);
    setAttempt((value) => value + 1);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const saved = await SecureStore.getItemAsync(BRIDGE_SESSION_KEY).catch(() => null);
        if (saved) {
          try {
            const session = JSON.parse(saved) as BridgeSession;
            const script = `(() => { const session = ${JSON.stringify(session)}; if (session.serverOrigin) localStorage.setItem('tjxy.api.baseUrl', session.serverOrigin); if (session.deviceId) localStorage.setItem('tjxy.web.deviceId', session.deviceId); if (session.rememberLogin && session.accessToken) { sessionStorage.setItem('tjxy.web.token', session.accessToken); localStorage.setItem('tjxy.web.rememberCredentials', '1'); } })();`;
            if (active) setBootstrapScript(script);
          } catch {
            await SecureStore.deleteItemAsync(BRIDGE_SESSION_KEY);
          }
        }
        const asset = Asset.fromModule(webBundleAsset);
        if (!asset.uri.startsWith('file:')) await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        const html = asset.localUri
          ? `${FileSystem.cacheDirectory}tjxy-app.html`
          : uri;
        if (asset.localUri) await FileSystem.copyAsync({ from: uri, to: html });
        if (active) {
          setHtmlUri(html);
          setReadAccessUri(html.slice(0, html.lastIndexOf('/') + 1));
        }
      } catch (error) {
        console.warn('TJXY bundle loading:', error);
        if (active) setLoadError(true);
      }
    })();
    return () => { active = false; };
  }, [attempt]);

  useEffect(() => {
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
      // expo/fetch may expose no ReadableStream on Android even though the
      // response has a binary body. arrayBuffer() keeps Blob/image requests
      // working across Android and desktop while preserving chunked messages.
      const bytes = new Uint8Array(await response.arrayBuffer());
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        postToWeb({
          kind: 'tjxy-fetch', id: message.id, phase: 'chunk',
          data: toBase64(bytes.subarray(offset, offset + CHUNK_BYTES)),
        });
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
    if (message.kind === 'tjxy-tv-back') {
      BackHandler.exitApp();
      return;
    }
    if (message.kind === 'tjxy-web-error') {
      console.warn('TJXY WebView:', message.message);
      setWebError(true);
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
          NativeAlert.alert('无法播放', '没有读取到登录会话，请重新登录后再试。');
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

  if (loadError || webError) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center gap-5 bg-background px-6">
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{loadError ? '无法加载应用界面' : '界面加载中断'}</Alert.Title>
            <Alert.Description>{loadError ? '请重试；若仍无法加载，请更新或重新安装应用。' : '应用界面暂时无法显示，请重新加载后继续。'}</Alert.Description>
          </Alert.Content>
        </Alert>
        <Button onPress={retry} accessibilityLabel="重新加载应用界面">
          <Button.Label>重新加载</Button.Label>
        </Button>
      </SafeAreaView>
    );
  }
  if (!htmlUri) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background" style={{ flex: 1 }}>
        <Spinner />
        <Typography className="text-sm text-muted" accessibilityLiveRegion="polite">正在准备应用界面…</Typography>
      </View>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1 }}>
      <WebView
        webviewDebuggingEnabled
        allowFileAccess
        allowingReadAccessToURL={readAccessUri ?? FileSystem.cacheDirectory ?? undefined}
        allowsFullscreenVideo={false}
        allowsInlineMediaPlayback
        domStorageEnabled
        injectedJavaScriptBeforeContentLoaded={`window.__TJXY_TV_MODE__=${Platform.isTV ? 'true' : 'false'};` + bootstrapScript + BRIDGE_SCRIPT}
        injectedJavaScript={`window.__TJXY_TV_MODE__=${Platform.isTV ? 'true' : 'false'};` + BRIDGE_SCRIPT}
        onMessage={onMessage}
        originWhitelist={['*']}
        ref={attachWebView}
        onNavigationStateChange={(state) => { canGoBack.current = state.canGoBack; }}
        onError={(event) => { console.warn('TJXY load error:', event.nativeEvent.description); setWebError(true); }}
        onRenderProcessGone={() => { setWebError(true); }}
        onContentProcessDidTerminate={() => { setWebError(true); }}
        source={{ uri: htmlUri }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        onShouldStartLoadWithRequest={(request) => {
          if (request.url.startsWith(htmlUri)) return true;
          if (request.url.startsWith('http://tjxy.app/') || request.url === 'about:blank') return true;
          void Linking.openURL(request.url);
          return false;
        }}
      />
    </SafeAreaView>
  );
}
