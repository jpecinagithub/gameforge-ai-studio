import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Gamepad2, Languages, Moon, Settings, Sun } from 'lucide-react';
import { useUiStore } from '../store';
import type { SupportedLang } from '../i18n';

export function Header() {
  const { t } = useTranslation();
  const { theme, toggleTheme, lang, setLang } = useUiStore();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 backdrop-blur dark:border-zinc-800">
      <Link to="/" className="flex items-center gap-2.5" aria-label={t('app.name')}>
        <img src="/icons/icon-192.svg" alt="" className="h-8 w-8" aria-hidden="true" />
        <span className="text-sm font-semibold tracking-tight text-zinc-100">
          {t('app.name')}
        </span>
      </Link>

      <div className="ml-auto flex items-center gap-1">
        <label className="sr-only" htmlFor="lang-select">
          {t('header.language')}
        </label>
        <div className="relative">
          <Languages
            className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
            aria-hidden="true"
          />
          <select
            id="lang-select"
            value={lang}
            onChange={(e) => setLang(e.target.value as SupportedLang)}
            className="appearance-none rounded-md border border-zinc-800 bg-zinc-900 py-1.5 pl-8 pr-2 text-xs text-zinc-300 hover:border-zinc-700"
            aria-label={t('header.language')}
          >
            <option value="en">EN</option>
            <option value="es">ES</option>
          </select>
        </div>

        <Link
          to="/settings"
          className="rounded-md p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label={t('nav.settings')}
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </Link>

        <button
          type="button"
          onClick={toggleTheme}
          className="rounded-md p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label={theme === 'dark' ? t('header.switchToLight') : t('header.switchToDark')}
        >
          {theme === 'dark' ? (
            <Sun className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Moon className="h-4 w-4" aria-hidden="true" />
          )}
        </button>

        <span className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-500 sm:flex">
          <Gamepad2 className="h-4 w-4" aria-hidden="true" />
          <span className="max-w-48 truncate">{t('app.tagline')}</span>
        </span>
      </div>
    </header>
  );
}
