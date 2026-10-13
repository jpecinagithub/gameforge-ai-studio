import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Archive, FolderPlus, Gamepad2, Pencil, Trash2 } from 'lucide-react';
import {
  artifactDownloadUrl,
  createProject,
  deleteProject,
  getBuildArtifacts,
  listBuilds,
  listProjects,
  updateProject,
} from '../api/client';
import type { Project } from '../types';
import type { ScreenshotSource } from '../components/ProjectThumbnail';
import { Header } from '../components/Header';
import { EmptyState } from '../components/EmptyState';
import { CardSkeleton } from '../components/Skeletons';
import { NewProjectDialog, type NewProjectValues } from '../components/NewProjectDialog';
import { EditProjectDialog, type EditProjectValues } from '../components/EditProjectDialog';
import { ProjectThumbnail } from '../components/ProjectThumbnail';
import { UpdatePrompt } from '../components/UpdatePrompt';

type LoadState = 'loading' | 'ready' | 'error';

export function Dashboard() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<LoadState>('loading');
  const [projects, setProjects] = useState<Project[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** Real game screenshots (latest verified build) per project id. */
  const [screenshots, setScreenshots] = useState<Record<string, ScreenshotSource>>({});

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

  // Fetch the latest verified build's screenshot for every project, in
  // parallel. Projects without visual evidence keep the generative art.
  useEffect(() => {
    if (state !== 'ready' || projects.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        projects.map(async (p) => {
          try {
            const builds = await listBuilds(p.id);
            const verified = builds
              .filter((b) => b.status === 'verified')
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            if (!verified) return null;
            const artifacts = await getBuildArtifacts(verified.id);
            const shot = artifacts.find((a) => a.kind === 'screenshot');
            if (!shot) return null;
            return [p.id, { downloadUrl: artifactDownloadUrl(shot.id), name: shot.name }] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const map: Record<string, ScreenshotSource> = {};
      for (const e of entries) {
        if (e) map[e[0]] = e[1];
      }
      setScreenshots(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [state, projects]);

  // ?new=1 auto-opens the dialog (used by the Studio sidebar "Create Game").
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setDialogOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleCreate = async (values: NewProjectValues) => {
    setCreating(true);
    setCreateError(null);
    try {
      // 30s timeout so the dialog never hangs silently.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout: el servidor no responde')), 30000),
      );
      await Promise.race([
        createProject({
          name: values.name,
          description: values.description || undefined,
        }),
        timeout,
      ]);
      setDialogOpen(false);
      await load();
    } catch (e) {
      // Keep the dialog open on failure; show the error inside it.
      const msg = e instanceof Error ? e.message : 'Error desconocido';
      setCreateError(msg);
      setState('error');
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async (values: EditProjectValues) => {
    if (!editing) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const updated = await updateProject(editing.id, {
        name: values.name,
        description: values.description || null,
      });
      setProjects((prev) => prev.map((project) => (
        project.id === updated.id ? updated : project
      )));
      setEditing(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : t('editProject.error'));
    } finally {
      setSavingEdit(false);
    }
  };

  const fmtDate = (iso: string | null | undefined) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleDateString(undefined, {
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
              <div
                key={p.id}
                className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60 transition-colors hover:border-zinc-600"
              >
                <Link to={`/projects/${p.id}`} className="block">
                  <ProjectThumbnail
                    projectId={p.id}
                    template={p.template}
                    kind={p.kind}
                    screenshot={screenshots[p.id] ?? null}
                  />
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2 pr-14">
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
                  </div>
                </Link>
                <div className="absolute right-2 top-2 flex gap-1 rounded-lg bg-zinc-900/90 p-0.5 shadow-sm">
                  <button
                    type="button"
                    onClick={() => { setEditError(null); setEditing(p); }}
                    title={t('dashboard.edit')}
                    aria-label={t('dashboard.edit')}
                    className="rounded-md p-1.5 text-zinc-400 hover:bg-cyan-900/40 hover:text-cyan-300"
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!window.confirm(t('dashboard.deleteConfirm', { name: p.name }))) return;
                      try {
                        await deleteProject(p.id);
                        setProjects((prev) => prev.filter((x) => x.id !== p.id));
                      } catch (err) {
                        alert(err instanceof Error ? err.message : String(err));
                      }
                    }}
                    title={t('dashboard.delete')}
                    aria-label={t('dashboard.delete')}
                    className="rounded-md p-1.5 text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <NewProjectDialog
        open={dialogOpen}
        busy={creating}
        error={createError}
        onClose={() => { setDialogOpen(false); setCreateError(null); }}
        onSubmit={(v) => void handleCreate(v)}
      />
      <EditProjectDialog
        key={editing?.id ?? 'closed'}
        project={editing}
        busy={savingEdit}
        error={editError}
        onClose={() => { if (!savingEdit) { setEditing(null); setEditError(null); } }}
        onSubmit={(values) => void handleEdit(values)}
      />
      <UpdatePrompt />
    </div>
  );
}
