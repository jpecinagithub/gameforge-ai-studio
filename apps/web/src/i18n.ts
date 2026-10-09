import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './i18n/en.json';
import es from './i18n/es.json';

export const SUPPORTED_LANGS = ['en', 'es'] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: SupportedLang = 'en';
const STORAGE_KEY = 'gameforge-lang';

function initialLang(): SupportedLang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'es') return stored;
  } catch {
    /* storage unavailable — fall through to default */
  }
  return DEFAULT_LANG;
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  lng: initialLang(),
  fallbackLng: DEFAULT_LANG,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

export function setLanguage(lang: SupportedLang): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = lang;
}

export default i18n;
