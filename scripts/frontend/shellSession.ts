import { persistRememberPreference } from './savedCredentials';

interface SignedInUser { Id: string; Name: string }

export function rememberSignedInUser(user: SignedInUser, remember = true): void {
  persistRememberPreference(remember);
  if (remember) window.localStorage.setItem('tjxy.web.savedUsername', user.Name);
  publishShellSession(user.Id);
}

export function publishShellSession(userId?: string): void {
  if (import.meta.env.VITE_TJXY_SHELL !== 'mobile') return;
  const bridge = (window as unknown as {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }).ReactNativeWebView;
  if (!bridge) return;
  bridge.postMessage(JSON.stringify({
    type: 'tjxy-session',
    payload: {
      serverOrigin: window.localStorage.getItem('tjxy.api.baseUrl') ?? '',
      deviceId: window.localStorage.getItem('tjxy.web.deviceId') ?? '',
      accessToken: window.sessionStorage.getItem('tjxy.web.token'),
      userId,
      rememberLogin: window.localStorage.getItem('tjxy.web.rememberCredentials') !== '0',
    },
  }));
}
