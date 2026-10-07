const USERNAME_KEY = 'tjxy.web.savedUsername';
const PASSWORD_KEY = 'tjxy.web.savedPassword';
const REMEMBER_KEY = 'tjxy.web.rememberCredentials';

export interface SavedCredentials {
  username: string;
  remember: boolean;
}

export function loadSavedCredentials(): SavedCredentials {
  if (typeof window === 'undefined') return { username: '', remember: true };
  window.localStorage.removeItem(PASSWORD_KEY);
  return {
    username: window.localStorage.getItem(USERNAME_KEY) ?? '',
    remember: window.localStorage.getItem(REMEMBER_KEY) !== '0',
  };
}

export function clearSavedCredentials(): void {
  window.localStorage.setItem(REMEMBER_KEY, '0');
  window.localStorage.removeItem(USERNAME_KEY);
  window.localStorage.removeItem(PASSWORD_KEY);
}

export function persistRememberPreference(remember: boolean): void {
  window.localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0');
  window.localStorage.removeItem(PASSWORD_KEY);
  if (!remember) window.localStorage.removeItem(USERNAME_KEY);
}
