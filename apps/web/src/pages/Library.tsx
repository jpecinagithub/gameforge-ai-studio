import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Gamepad2,
  LayoutDashboard,
  Library as LibraryIcon,
  Package,
  RefreshCw,
  Settings as SettingsIcon,
} from 'lucide-react';
import { listLibraryGames } from '../api/client';
import type { LibraryGame } from '../types';
import { Header } from '../components/Header';
import { EmptyState } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeletons';

type LoadState = 'loading' | 'ready' | 'error';

function fmtDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function Library() {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>('loading');
  const [games, setGames] = useState<LibraryGame[]>([]);

  const load = useCallback(async () => {
    setState('loading');
    try {
      setGames(await listLibraryGames());
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <Header />
      <nav
        aria-label={t('nav.dashboard')}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 px-3 py-2 lg:hidden"
      >
        <Link to="/" className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
          {t('nav.projects')}
        </Link>
        <Link to="/?new=1" className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
          {t('nav.createGame')}
        </Link>
        <Link
          to="/library"
          aria-current="page"
          className="whitespace-nowrap rounded-md bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-100"
        >
          {t('nav.library')}
        </Link>
        <Link to="/settings" className="whitespace-nowrap rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
          {t('nav.settings')}
        </Link>
      </nav>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          aria-label={t('nav.dashboard')}
          className="hidden min-h-0 flex-col gap-1 border-r border-zinc-800 p-3 lg:flex"
        >
          <Link to="/" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
            <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
            {t('nav.dashboard')}
          </Link>
          <Link to="/" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
            <Package className="h-4 w-4" aria-hidden="true" />
            {t('nav.projects')}
          </Link>
          <Link to="/?new=1" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
            <Gamepad2 className="h-4 w-4" aria-hidden="true" />
            {t('nav.createGame')}
            <ChevronRight className="ml-auto h-4 w-4 text-zinc-600" aria-hidden="true" />
          </Link>
          <Link
            to="/library"
            aria-current="page"
            className="flex items-center gap-2.5 rounded-md bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-100"
          >
            <LibraryIcon className="h-4 w-4 text-cyan-300" aria-hidden="true" />
            {t('nav.library')}
          </Link>
          <Link to="/settings" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
            <SettingsIcon className="h-4 w-4" aria-hidden="true" />
            {t('nav.settings')}
          </Link>
        </nav>

        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:py-10">
        <section className="relative mb-8 overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-950/60 via-zinc-900 to-fuchsia-950/30 px-5 py-7 sm:px-8 sm:py-9">
          <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />
          <div className="relative max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-cyan-300">
              <LibraryIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {t('library.eyebrow')}
            </div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('library.title')}</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-300 sm:text-base">
              {t('library.subtitle')}
            </p>
          </div>
        </section>

        {state === 'loading' && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label={t('library.loading')}>
            {Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} />)}
          </div>
        )}

        {state === 'error' && (
          <EmptyState
            title={t('library.loadError')}
            body={t('errors.network')}
            action={
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {t('common.retry')}
              </button>
            }
          />
        )}

        {state === 'ready' && games.length === 0 && (
          <EmptyState
            icon={<Gamepad2 className="h-10 w-10" aria-hidden="true" />}
            title={t('library.emptyTitle')}
            body={t('library.emptyBody')}
            action={
              <Link to="/" className="inline-flex min-h-11 items-center rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500">
                {t('library.goToProjects')}
              </Link>
            }
          />
        )}

        {state === 'ready' && games.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {games.map((game, index) => (
              <article key={game.buildId} className="group overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:border-cyan-500/40">
                <div className={`relative flex h-28 items-center justify-center overflow-hidden ${index % 3 === 0 ? 'bg-gradient-to-br from-cyan-950 to-blue-950' : index % 3 === 1 ? 'bg-gradient-to-br from-fuchsia-950 to-violet-950' : 'bg-gradient-to-br from-emerald-950 to-cyan-950'}`}>
                  <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.08)_1px,transparent_1px)] [background-size:24px_24px]" />
                  <Gamepad2 className="relative h-11 w-11 text-white/80 drop-shadow-[0_0_20px_rgba(34,211,238,.5)]" aria-hidden="true" />
                  <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/25">
                    <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    {t('library.verified')}
                  </span>
                </div>

                <div className="p-4">
                  <div className="mb-1.5 flex items-start justify-between gap-2">
                    <h2 className="line-clamp-1 text-base font-semibold text-zinc-100 group-hover:text-cyan-300">{game.name}</h2>
                    {game.kind && <span className="shrink-0 rounded-md bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{game.kind}</span>}
                  </div>
                  <p className="min-h-9 line-clamp-2 text-xs leading-[18px] text-zinc-400">
                    {game.description || t('library.noDescription')}
                  </p>
                  <p className="mt-2 text-[11px] text-zinc-600">{t('library.published', { date: fmtDate(game.publishedAt) })}</p>

                  <div className="mt-3 flex items-center gap-2">
                    <a
                      href={game.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500"
                    >
                      <Gamepad2 className="h-4 w-4" aria-hidden="true" />
                      {t('library.play')}
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                    {game.isEditable && (
                      <Link
                        to={`/projects/${game.projectId}`}
                        className="inline-flex min-h-9 items-center rounded-lg border border-zinc-700 px-2.5 text-xs text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800"
                      >
                        {t('library.edit')}
                      </Link>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
        </main>
      </div>
    </div>
  );
}
