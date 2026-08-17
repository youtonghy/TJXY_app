import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Uniwind } from 'uniwind';
import type { PublicSiteTheme } from '@tjxy/client-api';
import { useSiteSettings } from './siteSettings';

const THEME_KEY = 'tjxy.mobile.colorMode';

export type ColorMode = 'light' | 'dark';

Uniwind.setTheme('light');

interface ThemeValue {
  ready: boolean;
  mode: ColorMode;
  density: 'comfortable' | 'compact';
  siteThemeId: 'classic' | 'cinema';
  setMode: (mode: ColorMode) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme: siteTheme } = useSiteSettings();
  const [mode, setModeState] = useState<ColorMode>('light');
  const [ready, setReady] = useState(false);

  const appearance = useMemo(() => resolveSiteAppearance(siteTheme), [siteTheme]);

  useEffect(() => {
    const variables = appearance.siteThemeId === 'cinema' ? CINEMA_VARIABLES : CLASSIC_VARIABLES;
    Uniwind.updateCSSVariables('light', { ...variables.light, ...appearance.accent.light });
    Uniwind.updateCSSVariables('dark', { ...variables.dark, ...appearance.accent.dark });
  }, [appearance]);

  useEffect(() => {
    void AsyncStorage.getItem(THEME_KEY).then((value) => {
      const next: ColorMode = value === 'dark' ? 'dark' : 'light';
      setModeState(next);
      Uniwind.setTheme(next);
      setReady(true);
    });
  }, []);

  const value = useMemo<ThemeValue>(() => ({
    ready,
    mode,
    density: appearance.density,
    siteThemeId: appearance.siteThemeId,
    setMode(next) {
      setModeState(next);
      Uniwind.setTheme(next);
      void AsyncStorage.setItem(THEME_KEY, next);
    },
    toggle() {
      const next: ColorMode = mode === 'dark' ? 'light' : 'dark';
      setModeState(next);
      Uniwind.setTheme(next);
      void AsyncStorage.setItem(THEME_KEY, next);
    },
  }), [appearance.density, appearance.siteThemeId, mode, ready]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function resolveSiteAppearance(theme: PublicSiteTheme): {
  siteThemeId: 'classic' | 'cinema';
  density: 'comfortable' | 'compact';
  accent: AccentVariables;
} {
  if (theme.id !== 'cinema' || theme.schemaVersion !== 1) {
    return { siteThemeId: 'classic', density: 'comfortable', accent: ACCENTS.teal };
  }
  const accent = theme.options.accent;
  return {
    siteThemeId: 'cinema',
    density: theme.options.density === 'compact' ? 'compact' : 'comfortable',
    accent: accent === 'gold' ? ACCENTS.gold : accent === 'teal' ? ACCENTS.teal : ACCENTS.crimson,
  };
}

interface AccentVariables {
  light: Record<string, string>;
  dark: Record<string, string>;
}

const ACCENTS: Record<'crimson' | 'gold' | 'teal', AccentVariables> = {
  crimson: {
    light: { '--accent': '#e50914', '--accent-foreground': '#fcfcfc' },
    dark: { '--accent': '#e50914', '--accent-foreground': '#fcfcfc' },
  },
  gold: {
    light: { '--accent': 'oklch(68% 0.13 78)', '--accent-foreground': 'oklch(20% 0.03 78)' },
    dark: { '--accent': 'oklch(68% 0.13 78)', '--accent-foreground': 'oklch(20% 0.03 78)' },
  },
  teal: {
    light: { '--accent': 'oklch(57% 0.11 180)', '--accent-foreground': 'oklch(98% 0.004 180)' },
    dark: { '--accent': 'oklch(72% 0.105 180)', '--accent-foreground': 'oklch(16% 0.025 190)' },
  },
};

const CLASSIC_VARIABLES = {
  light: {
    '--radius': 8, '--field-radius': 8,
    '--background': 'oklch(0.978 0.004 180)', '--foreground': 'oklch(0.24 0.018 215)',
    '--surface': 'oklch(0.994 0.002 180)', '--surface-secondary': 'oklch(0.955 0.006 185)',
    '--surface-tertiary': 'oklch(0.925 0.009 190)', '--overlay': 'oklch(0.996 0.002 180)',
    '--muted': 'oklch(0.49 0.022 215)', '--default': 'oklch(0.925 0.008 200)',
    '--default-foreground': 'oklch(0.3 0.018 215)', '--border': 'oklch(0.88 0.012 200)',
    '--separator': 'oklch(0.915 0.009 200)', '--field-background': 'oklch(0.994 0.002 180)',
    '--field-foreground': 'oklch(0.24 0.018 215)', '--field-placeholder': 'oklch(0.49 0.022 215)',
    '--field-border': 'oklch(0.88 0.012 200)',
  },
  dark: {
    '--radius': 8, '--field-radius': 8,
    '--background': 'oklch(0.145 0.012 215)', '--foreground': 'oklch(0.965 0.006 190)',
    '--surface': 'oklch(0.19 0.014 215)', '--surface-secondary': 'oklch(0.23 0.015 215)',
    '--surface-tertiary': 'oklch(0.27 0.016 215)', '--overlay': 'oklch(0.2 0.014 215)',
    '--muted': 'oklch(0.72 0.018 205)', '--default': 'oklch(0.27 0.016 215)',
    '--default-foreground': 'oklch(0.965 0.006 190)', '--border': 'oklch(0.31 0.018 210)',
    '--separator': 'oklch(0.27 0.015 210)', '--field-background': 'oklch(0.27 0.016 215)',
    '--field-foreground': 'oklch(0.965 0.006 190)', '--field-placeholder': 'oklch(0.72 0.018 205)',
    '--field-border': 'oklch(0.31 0.018 210)',
  },
} as const;

const CINEMA_VARIABLES = {
  light: {
    '--radius': 8, '--field-radius': 2,
    '--background': '#f5f5f5', '--foreground': '#18181b', '--surface': '#ffffff',
    '--surface-secondary': '#efefef', '--surface-tertiary': '#eaeaea', '--overlay': '#ffffff',
    '--muted': '#727272', '--default': '#ebebeb', '--default-foreground': '#18181b',
    '--border': '#dedede', '--separator': '#e4e4e4', '--field-background': '#ffffff',
    '--field-foreground': '#18181b', '--field-placeholder': '#727272', '--field-border': '#dedede',
  },
  dark: {
    '--radius': 8, '--field-radius': 2,
    '--background': '#060606', '--foreground': '#fcfcfc', '--surface': '#181818',
    '--surface-secondary': '#232323', '--surface-tertiary': '#272727', '--overlay': '#181818',
    '--muted': '#a0a0a0', '--default': '#272727', '--default-foreground': '#fcfcfc',
    '--border': '#292929', '--separator': '#222222', '--field-background': '#181818',
    '--field-foreground': '#fcfcfc', '--field-placeholder': '#a0a0a0', '--field-border': '#292929',
  },
} as const;

export function useColorMode(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useColorMode must be used inside ThemeProvider');
  return value;
}
