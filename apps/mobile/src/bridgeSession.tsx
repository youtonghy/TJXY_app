import { fetch as expoFetch } from 'expo/fetch';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ClientSession } from '@tjxy/client-api';

export interface BridgeSession {
  serverOrigin: string;
  accessToken: string | null;
  deviceId: string;
  userId?: string;
}

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
    setSession,
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
