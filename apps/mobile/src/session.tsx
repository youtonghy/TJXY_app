import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import {
  authenticate,
  ClientApiError,
  getMe,
  logout,
  normalizeOrigin,
  probeServer,
  type ClientSession,
} from '@tjxy/client-api';

const BASE_KEY = 'tjxy.api.baseUrl';
const TOKEN_KEY = 'tjxy.mobile.token';
const DEVICE_KEY = 'tjxy.mobile.deviceId';
const USERNAME_KEY = 'tjxy.mobile.username';
const PASSWORD_KEY = 'tjxy.mobile.password';

function isAuthenticationError(error: unknown): boolean {
  return error instanceof ClientApiError && error.kind === 'authentication';
}

interface SessionValue {
  ready: boolean;
  baseUrl: string | null;
  token: string | null;
  user: { Id: string; Name: string } | null;
  client: ClientSession | null;
  saveServer: (origin: string) => Promise<void>;
  signIn: (username: string, password: string, remember?: boolean) => Promise<void>;
  adoptAuthentication: (accessToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  savedUsername: string;
  savedPassword: string;
}

const SessionContext = createContext<SessionValue | null>(null);

async function deviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = `tjxy-mobile-${Date.now()}`;
  await AsyncStorage.setItem(DEVICE_KEY, created);
  return created;
}

function buildClient(baseUrl: string, token: string | null, id: string): ClientSession {
  return {
    baseUrl,
    token,
    deviceId: id,
    clientName: 'TJXY Mobile',
    deviceName: 'Phone',
    eventStreamMode: 'buffered',
    fetch: (input, init) => expoFetch(input, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body ?? undefined,
      signal: init?.signal ?? undefined,
      credentials: 'omit',
      redirect: init?.redirect,
    }),
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<{ Id: string; Name: string } | null>(null);
  const [id, setId] = useState('tjxy-mobile');
  const [savedUsername, setSavedUsername] = useState('');
  const [savedPassword, setSavedPassword] = useState('');

  useEffect(() => {
    void (async () => {
      const [storedBase, storedToken, storedId, storedUser, storedPassword] = await Promise.all([
        AsyncStorage.getItem(BASE_KEY),
        SecureStore.getItemAsync(TOKEN_KEY),
        deviceId(),
        SecureStore.getItemAsync(USERNAME_KEY),
        SecureStore.getItemAsync(PASSWORD_KEY),
      ]);
      setId(storedId);
      setBaseUrl(storedBase);
      setToken(storedToken);
      setSavedUsername(storedUser ?? '');
      setSavedPassword(storedPassword ?? '');
      if (storedBase && storedToken) {
        try {
          const me = await getMe(buildClient(storedBase, storedToken, storedId));
          setUser(me);
        } catch (error) {
          if (isAuthenticationError(error)) {
            await SecureStore.deleteItemAsync(TOKEN_KEY);
            setToken(null);
          } else {
            console.warn('Unable to validate the saved session.', error);
          }
        }
      }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!baseUrl || !token || !ready) return undefined;
    let disposed = false;
    const validate = async () => {
      try {
        const me = await getMe(buildClient(baseUrl, token, id));
        if (!disposed) setUser(me);
      } catch (error) {
        if (disposed) return;
        if (isAuthenticationError(error)) {
          await SecureStore.deleteItemAsync(TOKEN_KEY);
          setToken(null);
          setUser(null);
        } else {
          console.warn('Unable to refresh the session.', error);
        }
      }
    };
    const interval = setInterval(() => { void validate(); }, 60_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void validate();
    });
    return () => {
      disposed = true;
      clearInterval(interval);
      subscription.remove();
    };
  }, [baseUrl, id, ready, token]);

  const value = useMemo<SessionValue>(() => ({
    ready,
    baseUrl,
    token,
    user,
    client: baseUrl ? buildClient(baseUrl, token, id) : null,
    async saveServer(origin: string) {
      const probed = await probeServer(origin);
      await AsyncStorage.setItem(BASE_KEY, probed);
      if (baseUrl && probed !== baseUrl) {
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        setToken(null);
        setUser(null);
      }
      setBaseUrl(probed);
    },
    async signIn(username, password, remember = true) {
      if (!baseUrl) throw new Error('missing server');
      const nextToken = await authenticate(buildClient(baseUrl, null, id), username, password);
      await SecureStore.setItemAsync(TOKEN_KEY, nextToken);
      if (remember) {
        await SecureStore.setItemAsync(USERNAME_KEY, username);
        await SecureStore.setItemAsync(PASSWORD_KEY, password);
      } else {
        await SecureStore.deleteItemAsync(USERNAME_KEY);
        await SecureStore.deleteItemAsync(PASSWORD_KEY);
      }
      const me = await getMe(buildClient(baseUrl, nextToken, id));
      setToken(nextToken);
      setSavedUsername(remember ? username : '');
      setSavedPassword(remember ? password : '');
      setUser(me);
    },
    async adoptAuthentication(accessToken: string) {
      if (!baseUrl) throw new Error('missing server');
      const me = await getMe(buildClient(baseUrl, accessToken, id));
      await SecureStore.setItemAsync(TOKEN_KEY, accessToken);
      setToken(accessToken);
      setUser(me);
    },
    async signOut() {
      if (baseUrl && token) {
        try { await logout(buildClient(baseUrl, token, id)); } catch { /* ignore */ }
      }
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      setToken(null);
      setUser(null);
    },
    savedUsername,
    savedPassword,
  }), [baseUrl, id, ready, savedPassword, savedUsername, token, user]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

export function useClient(): ClientSession {
  const { client } = useSession();
  if (!client) throw new Error('server is not configured');
  return client;
}

export { normalizeOrigin };
