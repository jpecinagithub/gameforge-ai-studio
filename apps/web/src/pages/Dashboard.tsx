import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Archive, FolderPlus, Gamepad2 } from 'lucide-react';
import {
  createProject,
  listProjects,
  ApiError,
} from '../api/client';
import type { Project } from '../types';
import { Header } from '../components/Header';
import { EmptyState } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeletons';
import { NewProjectDialog, type NewProjectValues } from '../components/NewProjectDialog';
import { UpdatePrompt } from '../components/UpdatePrompt';

type LoadState = 'loading' | 'ready' | 'error';

export function Dashboard() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<LoadState>('loading');
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const page = await listProjects();
      setProjects(page.items);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ?new=1 auto-opens the dialog (used by the Studio sidebar "Create Game").
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setDialogOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleCreate = async (values: NewProjectValues) => {
    setCreating(true);
    try {
      await createProject({
        name: values.name,
        description: values.description || undefined,
        template: values.template,
        kind: values.kind,
        engine: 'three',
      });
      setDialogOpen(false);
      await load();
    } catch (e) {
      // Keep the dialog open on failure; surface via the error state below.
      if (e instanceof ApiError) setState('error');
      else setState('error');
    } finally {
      setCreating(false);
    }
  };

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">{t('dashboard.title')}</h1>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500"
          >
            <FolderPlus className="h-4 w-4" aria-hidden="true" />
            {t('dashboard.newProject')}
          </button>
        </div>

        {state === 'loading' && (
          <div
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
            aria-label={t('dashboard.loading')}
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        )}

        {state === 'error' && (
          <EmptyState
            title={t('dashboard.error')}
            body=""
            action={
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
              >
                {t('dashboard.retry')}
              </button>
            }
          />
        )}

        {state === 'ready' && projects.length === 0 && (
          <EmptyState
            icon={<Gamepad2 className="h-10 w-10" aria-hidden="true" />}
            title={t('dashboard.emptyTitle')}
            body={t('dashboard.emptyBody')}
            action={
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500"
              >
                {t('dashboard.createFirst')}
              </button>
            }
          />
        )}

        {state === 'ready' && projects.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link
                key={p.id}
                to={`/projects/${p.id}`}
                className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-600"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="truncate text-base font-semibold text-zinc-100 group-hover:text-cyan-300">
                    {p.name}
                  </h2>
                  {p.status === 'archived' && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                      <Archive className="h-3 w-3" aria-hidden="true" />
                      {t('dashboard.archived')}
                    </span>
                  )}
                </div>
                {p.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-zinc-400">{p.description}</p>
                )}
                <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
                  <span>{t('dashboard.updated', { date: fmtDate(p.updated_at) })}</span>
                  <span className="font-medium text-cyan-400 group-hover:text-cyan-300">
                    {t('dashboard.open')} →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      <NewProjectDialog
        open={dialogOpen}
        busy={creating}
        onClose={() => setDialogOpen(false)}
        onSubmit={(v) => void handleCreate(v)}
      />
      <UpdatePrompt />
    </div>
  );
}
