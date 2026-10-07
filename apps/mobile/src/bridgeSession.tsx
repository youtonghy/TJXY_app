import { fetch as expoFetch } from 'expo/fetch';
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ClientSession } from '@tjxy/client-api';

export interface BridgeSession {
  serverOrigin: string;
  accessToken: string | null;
  deviceId: string;
  userId?: string;
  rememberLogin?: boolean;
}

export const BRIDGE_SESSION_KEY = 'tjxy.bridge.session';

interface BridgeSessionValue {
  session: BridgeSession | null;
  client: ClientSession | null;
  setSession: (session: BridgeSession) => void;
}

const BridgeSessionContext = createContext<BridgeSessionValue | null>(null);

export function buildClient(session: BridgeSession): ClientSession {
  return {
    baseUrl: session.serverOrigin,
    token: session.accessToken,
    deviceId: session.deviceId,
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

export function BridgeSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<BridgeSession | null>(null);
  const value = useMemo<BridgeSessionValue>(() => ({
    session,
    client: session ? buildClient(session) : null,
    setSession: (next) => {
      setSession(next);
      if (!next.accessToken) {
        void SecureStore.deleteItemAsync(BRIDGE_SESSION_KEY).catch(() => {
          console.warn('Could not clear the TJXY session.');
        });
        return;
      }
      const saved = { ...next, accessToken: next.rememberLogin ? next.accessToken : null };
      void SecureStore.setItemAsync(BRIDGE_SESSION_KEY, JSON.stringify(saved)).catch(() => {
        console.warn('Could not persist the TJXY session.');
      });
    },
  }), [session]);
  return <BridgeSessionContext.Provider value={value}>{children}</BridgeSessionContext.Provider>;
}

export function useBridgeSession(): BridgeSessionValue {
  const value = useContext(BridgeSessionContext);
  if (!value) throw new Error('useBridgeSession must be used inside BridgeSessionProvider');
  return value;
}

export function useClient(): ClientSession | null {
  return useBridgeSession().client;
}
