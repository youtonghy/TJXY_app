import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  getPublicBranding,
  isAbortError,
  resolveApiUrl,
  type PublicSiteTheme,
} from '@tjxy/client-api';
import { useSession } from './session';

export interface SiteBranding {
  title: string;
  subtitle: string;
  logoUri?: string;
}

export interface SiteSettingsValue {
  branding: SiteBranding;
  theme: PublicSiteTheme;
}

const fallback: SiteSettingsValue = {
  branding: { title: 'TJXY', subtitle: 'Your media library' },
  theme: { id: 'classic', schemaVersion: 1, options: {}, revision: 0 },
};

const SiteSettingsContext = createContext<SiteSettingsValue>(fallback);

export function SiteSettingsProvider({ children }: { children: ReactNode }) {
  const { client } = useSession();
  const [settings, setSettings] = useState(fallback);

  useEffect(() => {
    if (!client) {
      setSettings(fallback);
      return;
    }
    const abort = new AbortController();
    void getPublicBranding(client, abort.signal)
      .then((value) => {
        setSettings({
          branding: {
            title: value.SiteTitle,
            subtitle: value.SiteSubtitle,
            logoUri: resolveApiUrl(value.LogoUrl, client.baseUrl),
          },
          theme: value.Theme,
        });
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) setSettings(fallback);
      });
    return () => { abort.abort(); };
  }, [client]);

  const value = useMemo(() => settings, [settings]);
  return <SiteSettingsContext.Provider value={value}>{children}</SiteSettingsContext.Provider>;
}

export function useSiteSettings(): SiteSettingsValue {
  return useContext(SiteSettingsContext);
}
