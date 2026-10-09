import { create } from 'zustand';
import type { SupportedLang } from './i18n';
import { setLanguage } from './i18n';

export type Theme = 'dark' | 'light';
const THEME_KEY = 'gameforge-theme';

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* ignore */
  }
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

interface UiState {
  theme: Theme;
  lang: SupportedLang;
  toggleTheme: () => void;
  setLang: (lang: SupportedLang) => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: initialTheme(),
  lang: ((): SupportedLang => {
    try {
      const s = localStorage.getItem('gameforge-lang');
      return s === 'es' ? 'es' : 'en';
    } catch {
      return 'en';
    }
  })(),
  toggleTheme: () =>
    set((s) => {
      const next: Theme = s.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      return { theme: next };
    }),
  setLang: (lang) => {
    setLanguage(lang);
    set({ lang });
  },
}));
