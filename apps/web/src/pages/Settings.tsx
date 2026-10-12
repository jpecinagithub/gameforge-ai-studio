import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2, LockKeyhole, Moon, Sun } from 'lucide-react';
import {
  apiBaseUrl,
  getModelCapabilities,
} from '../api/client';
import { Header } from '../components/Header';
import { EmptyState } from '../components/EmptyState';
import { useUiStore, type Theme } from '../store';
import type { SupportedLang } from '../i18n';

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5">
      <h2 className="mb-3 text-sm font-semibold text-zinc-200">{title}</h2>
      {children}
    </section>
  );
}

export function Settings() {
  const { t } = useTranslation();
  const { theme, toggleTheme, lang, setLang } = useUiStore();

  const [roles, setRoles] = useState<string[]>([]);
  const [provider, setProvider] = useState('');
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const caps = await getModelCapabilities();
        if (cancelled) return;
        setRoles(caps.agentRoles ?? []);
        setProvider(caps.provider ?? '');
        setActiveModel(caps.activeModel ?? null);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <Header />
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <Link
          to="/"
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label={t('nav.back')}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <h1 className="text-sm font-semibold">{t('settings.title')}</h1>
      </div>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 px-4 py-6">
        <Section title={t('settings.appearance')}>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-400">{t('settings.theme')}</span>
              <div className="flex rounded-lg bg-zinc-950 p-1 ring-1 ring-zinc-800" role="group">
                {(['dark', 'light'] as Theme[]).map((th) => (
                  <button
                    key={th}
                    type="button"
                    onClick={() => {
                      if (theme !== th) toggleTheme();
                    }}
                    aria-pressed={theme === th}
                    className={`inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 py-2 text-sm ${
                      theme === th
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {th === 'dark' ? (
                      <Moon className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Sun className="h-4 w-4" aria-hidden="true" />
                    )}
                    {t(th === 'dark' ? 'settings.themeDark' : 'settings.themeLight')}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="settings-lang" className="text-sm text-zinc-400">
                {t('settings.language')}
              </label>
              <select
                id="settings-lang"
                value={lang}
                onChange={(e) => setLang(e.target.value as SupportedLang)}
                className="min-h-11 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200"
              >
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </div>
          </div>
        </Section>

        <Section title={t('settings.backend')}>
          <div className="text-sm">
            <p className="text-zinc-500">{t('settings.apiUrl')}</p>
            <p className="mt-1 select-all break-all font-mono text-zinc-200">
              {apiBaseUrl()}
            </p>
            <p className="mt-1 text-xs text-zinc-600">{t('settings.apiUrlNote')}</p>
          </div>
        </Section>

        <Section title={t('settings.models')}>
          {loading ? (
            <div className="flex items-center justify-center py-8" role="status">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-500" aria-hidden="true" />
            </div>
          ) : error ? (
            <EmptyState title={t('settings.loadError')} body={t('errors.network')} />
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                  <p className="text-xs text-zinc-500">{t('settings.provider')}</p>
                  <p className="mt-1 font-mono text-sm text-zinc-100">{provider || '—'}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                  <p className="text-xs text-zinc-500">{t('settings.activeModel')}</p>
                  <p className="mt-1 break-all font-mono text-sm text-cyan-300">
                    {activeModel || t('settings.notConfigured')}
                  </p>
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs text-zinc-500">{t('settings.rolesUsingModel')}</p>
                <div className="flex flex-wrap gap-2">
                  {roles.map((role) => (
                    <span key={role} className="rounded-md bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-300">
                      {role}
                    </span>
                  ))}
                </div>
              </div>
              <p className="flex items-start gap-2 rounded-lg border border-cyan-900/50 bg-cyan-950/20 p-3 text-xs leading-5 text-zinc-400">
                <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" aria-hidden="true" />
                {t('settings.serverManaged')}
              </p>
            </div>
          )}
        </Section>
      </main>
    </div>
  );
}
