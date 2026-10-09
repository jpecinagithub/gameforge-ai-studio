import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { getProject, listRevisions } from '../api/client';
import type { Project, Revision } from '../types';
import { Header } from '../components/Header';
import { EmptyState } from '../components/EmptyState';

const PAGE_SIZE = 50;

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

export function Revisions() {
  const { t } = useTranslation();
  const { id: projectId } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [p, r] = await Promise.all([
          getProject(projectId),
          listRevisions(projectId, page, PAGE_SIZE),
        ]);
        if (!cancelled) {
          setProject(p);
          setRevisions(r.items ?? []);
          setTotal(r.total ?? 0);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <Header />
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <Link
          to={projectId ? `/projects/${projectId}` : '/'}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label={t('nav.back')}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <h1 className="truncate text-sm font-semibold">
          {project?.name ?? '…'} — {t('revisions.title')}
        </h1>
      </div>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-16" role="status">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-500" aria-hidden="true" />
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : error ? (
          <EmptyState title={t('revisions.loadError')} body={t('errors.network')} />
        ) : revisions.length === 0 ? (
          <EmptyState title={t('revisions.emptyTitle')} body={t('revisions.emptyBody')} />
        ) : (
          <>
            <ol className="relative space-y-3 border-l border-zinc-800 pl-5">
              {revisions.map((r) => (
                <li key={r.id} className="relative">
                  <span
                    className={`absolute -left-[26px] top-4 h-2.5 w-2.5 rounded-full ring-4 ring-zinc-950 ${
                      r.healthy ? 'bg-emerald-600' : 'bg-red-600'
                    }`}
                    aria-hidden="true"
                  />
                  <article className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {r.healthy ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-950 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                          {t('revisions.healthy')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-950 px-2 py-0.5 text-[11px] font-medium text-red-300">
                          <XCircle className="h-3 w-3" aria-hidden="true" />
                          {t('revisions.unhealthy')}
                        </span>
                      )}
                      <span className="font-mono text-xs text-zinc-500">
                        {r.sha.slice(0, 12)}
                      </span>
                      {r.checkpointKind && (
                        <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                          {t('revisions.checkpoint')}: {r.checkpointKind}
                        </span>
                      )}
                    </div>
                    {r.message && (
                      <p className="mt-2 text-sm text-zinc-200">{r.message}</p>
                    )}
                    <p className="mt-1.5 text-xs text-zinc-600">
                      {t('revisions.author')}: {r.author} · {fmtDateTime(r.createdAt)}
                    </p>
                  </article>
                </li>
              ))}
            </ol>

            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="min-h-11 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                >
                  {t('revisions.prev')}
                </button>
                <span className="text-xs text-zinc-500">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="min-h-11 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                >
                  {t('revisions.next')}
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
