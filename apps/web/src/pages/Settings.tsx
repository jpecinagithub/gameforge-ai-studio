import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Loader2, Moon, Sun } from 'lucide-react';
import {
  apiBaseUrl,
  getModelCapabilities,
  getSettings,
  listModels,
  patchSettings,
} from '../api/client';
import type { ModelInfo } from '../types';
import { Header } from '../components/Header';
import { EmptyState } from '../components/EmptyState';
import { useUiStore, type Theme } from '../store';
import type { SupportedLang } from '../i18n';

type ModelByRole = Record<string, string>;

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
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [bindings, setBindings] = useState<ModelByRole>({});
  const [provider, setProvider] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number>(0);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, modelList, caps] = await Promise.all([
          getSettings(),
          listModels().catch(() => ({ items: [] })),
          getModelCapabilities().catch(() => null),
        ]);
        if (cancelled) return;
        const byRole = settings['modelByRole'];
        setBindings(
          byRole && typeof byRole === 'object' && !Array.isArray(byRole)
            ? (byRole as ModelByRole)
            : {},
        );
        setModels(modelList.items ?? []);
        setRoles(caps?.agentRoles ?? []);
        setProvider(caps?.provider ?? '');
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

  const setBinding = async (role: string, modelId: string) => {
    setSaving(role);
    setSaveError(false);
    const next: ModelByRole = { ...bindings };
    if (modelId) next[role] = modelId;
    else delete next[role];
    try {
      const updated = await patchSettings({ modelByRole: next });
      const byRole = updated['modelByRole'];
      setBindings(
        byRole && typeof byRole === 'object' && !Array.isArray(byRole)
          ? (byRole as ModelByRole)
          : next,
      );
      setSavedAt(Date.now());
    } catch {
      setSaveError(true);
    } finally {
      setSaving(null);
    }
  };

  const modelLabel = (id: string): string =>
    models.find((m) => m.modelId === id)?.displayName ?? id;

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
            <>
              {provider && (
                <p className="mb-3 text-xs text-zinc-500">
                  {t('settings.provider')}: <span className="font-mono">{provider}</span>
                </p>
              )}
              {roles.length === 0 ? (
                <p className="text-sm text-zinc-500">{t('settings.noModels')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-105 text-left text-sm">
                    <thead>
                      <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
                        <th className="py-2 pr-4 font-medium">{t('settings.role')}</th>
                        <th className="py-2 font-medium">{t('settings.model')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roles.map((role) => (
                        <tr key={role} className="border-b border-zinc-800/50 last:border-0">
                          <td className="py-2.5 pr-4 font-mono text-xs text-zinc-300">
                            {role}
                          </td>
                          <td className="py-2.5">
                            <div className="flex items-center gap-2">
                              <select
                                value={bindings[role] ?? ''}
                                disabled={saving !== null}
                                onChange={(e) => void setBinding(role, e.target.value)}
                                aria-label={`${t('settings.model')} — ${role}`}
                                className="min-h-11 w-full max-w-70 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-sm text-zinc-200 disabled:opacity-60"
                              >
                                <option value="">{t('settings.unbound')}</option>
                                {models.map((m) => (
                                  <option key={m.modelId} value={m.modelId}>
                                    {m.displayName}
                                  </option>
                                ))}
                              </select>
                              {saving === role ? (
                                <Loader2
                                  className="h-4 w-4 animate-spin text-zinc-500"
                                  aria-hidden="true"
                                />
                              ) : (
                                bindings[role] && (
                                  <span
                                    className="hidden truncate text-xs text-zinc-500 sm:inline"
                                    title={bindings[role]}
                                  >
                                    {modelLabel(bindings[role] as string)}
                                  </span>
                                )
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {saveError && (
                <p className="mt-2 text-sm text-red-300" role="alert">
                  {t('settings.saveError')}
                </p>
              )}
              {!saveError && savedAt > 0 && (
                <p className="mt-2 inline-flex items-center gap-1 text-sm text-emerald-300" role="status">
                  <Check className="h-4 w-4" aria-hidden="true" />
                  {t('settings.saved')}
                </p>
              )}
            </>
          )}
        </Section>
      </main>
    </div>
  );
}
