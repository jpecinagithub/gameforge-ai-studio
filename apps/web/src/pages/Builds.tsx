import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  MinusCircle,
  X,
  XCircle,
} from 'lucide-react';
import {
  artifactDownloadUrl,
  getBuild,
  getBuildArtifacts,
  getBuildReviews,
  getBuildTests,
  getProject,
  listBuilds,
} from '../api/client';
import type { BuildArtifact, BuildJob, Project, ReviewResult, TestResult } from '../types';
import { Header } from '../components/Header';
import { StatusPill } from '../components/StatusPill';
import { EmptyState } from '../components/EmptyState';

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

function fmtBytes(bytes: number | null | undefined): string {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) < 0) return '—';
  const b = Number(bytes);
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(b >= 10 * 1024 ? 0 : 1)} KB`;
}

function fmtDuration(ms: number | null | undefined): string {
  if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return '—';
  return `${Math.round(Number(ms))} ms`;
}

function PhaseIcon({ status }: { status: string }) {
  if (status === 'pass')
    return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />;
  if (status === 'fail')
    return <XCircle className="h-4 w-4 text-red-400" aria-hidden="true" />;
  return <MinusCircle className="h-4 w-4 text-zinc-500" aria-hidden="true" />;
}

function resultIcon(result: string) {
  const r = result.toLowerCase();
  if (r === 'pass' || r === 'passed' || r === 'success') {
    return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />;
  }
  if (r === 'fail' || r === 'failed') {
    return <XCircle className="h-4 w-4 text-red-400" aria-hidden="true" />;
  }
  return <MinusCircle className="h-4 w-4 text-zinc-500" aria-hidden="true" />;
}

function BuildDetail({
  build,
  tests,
  reviews,
  artifacts,
  onClose,
}: {
  build: BuildJob;
  tests: TestResult[];
  reviews: ReviewResult[];
  artifacts: BuildArtifact[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const phases = build.verdict?.phases ?? [];

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('buildDetail.title')}
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-zinc-950 ring-1 ring-zinc-800 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center gap-3">
            <StatusPill kind="build" status={build.status} />
            <span className="text-sm font-medium text-zinc-200">
              {t('buildDetail.title')}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 min-w-11 rounded-md p-2.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label={t('buildDetail.close')}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div className="text-xs text-zinc-500">
            <p>{t('buildDetail.revision', { sha: build.revision_sha.slice(0, 12) })}</p>
            <p>{fmtDateTime(build.created_at)}</p>
            {build.preview_url && (
              <a
                href={build.preview_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300"
              >
                {t('buildDetail.preview')}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </div>

          {(build.verdict?.summary || build.verdict?.failed_phase) && (
            <section aria-label={t('buildDetail.verdict')}>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {t('buildDetail.verdict')}
              </h3>
              {build.verdict.summary && (
                <p className="text-sm text-zinc-300">{build.verdict.summary}</p>
              )}
              {build.verdict.failed_phase && (
                <p className="mt-1 font-mono text-xs text-red-300">
                  {build.verdict.failed_phase}
                </p>
              )}
            </section>
          )}

          <section aria-label={t('buildDetail.phases')}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {t('buildDetail.phases')}
            </h3>
            {phases.length === 0 ? (
              <p className="text-sm text-zinc-500">{t('buildDetail.noPhases')}</p>
            ) : (
              <ul className="space-y-1">
                {phases.map((p) => (
                  <li
                    key={p.name}
                    className="flex items-start gap-2.5 rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-3 py-2"
                  >
                    <span className="mt-0.5 shrink-0">
                      <PhaseIcon status={p.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs text-zinc-200">
                        {p.name}{' '}
                        <span className="text-zinc-500">
                          ·{' '}
                          {t(
                            p.status === 'pass'
                              ? 'buildDetail.phasePass'
                              : p.status === 'fail'
                                ? 'buildDetail.phaseFail'
                                : 'buildDetail.phaseSkip',
                          )}
                        </span>
                      </p>
                      {p.error && (
                        <p className="mt-0.5 break-words text-xs text-red-300/90">
                          {p.error}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label={t('buildDetail.tests')}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {t('buildDetail.tests')}
            </h3>
            {tests.length === 0 ? (
              <p className="text-sm text-zinc-500">{t('buildDetail.noTests')}</p>
            ) : (
              <ul className="space-y-1">
                {tests.map((tr, i) => (
                  <li
                    key={`${tr.suite ?? ''}:${tr.name}:${i}`}
                    className="flex items-start gap-2.5 rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-3 py-2"
                  >
                    <span className="mt-0.5 shrink-0">{resultIcon(tr.status)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs text-zinc-200">
                        {tr.suite ? `${tr.suite} / ` : ''}
                        {tr.name}{' '}
                        <span className="text-zinc-500">· {fmtDuration(tr.durationMs)}</span>
                      </p>
                      {typeof tr.details === 'string' && tr.details && (
                        <p className="mt-0.5 break-words text-xs text-zinc-400">
                          {tr.details}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label={t('buildDetail.reviews')}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {t('buildDetail.reviews')}
            </h3>
            {reviews.length === 0 ? (
              <p className="text-sm text-zinc-500">{t('buildDetail.noReviews')}</p>
            ) : (
              <ul className="space-y-1">
                {reviews.map((rv, i) => (
                  <li
                    key={`${rv.criterion}:${i}`}
                    className="flex items-start gap-2.5 rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-3 py-2"
                  >
                    <span className="mt-0.5 shrink-0">{resultIcon(rv.result)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-zinc-200">
                        {rv.criterion}{' '}
                        <span className="text-zinc-500">· {rv.result}</span>
                      </p>
                      {typeof rv.confidence === 'number' && (
                        <p className="mt-0.5 text-xs text-zinc-500">
                          {t('buildDetail.confidence', {
                            value: Math.round(rv.confidence * 100),
                          })}
                        </p>
                      )}
                      {rv.issue && (
                        <p className="mt-0.5 break-words text-xs text-amber-300/90">
                          {rv.issue}
                        </p>
                      )}
                      {rv.recommendation && (
                        <p className="mt-0.5 break-words text-xs text-zinc-400">
                          {rv.recommendation}
                        </p>
                      )}
                      {rv.retestRequired && (
                        <p className="mt-0.5 text-xs font-medium text-amber-300">
                          {t('buildDetail.retestRequired')}
                        </p>
                      )}
                      {rv.judgeModel && (
                        <p className="mt-0.5 font-mono text-[11px] text-zinc-600">
                          {rv.judgeModel}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label={t('buildDetail.artifacts')}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {t('buildDetail.artifacts')}
            </h3>
            {artifacts.length === 0 ? (
              <p className="text-sm text-zinc-500">{t('buildDetail.noArtifacts')}</p>
            ) : (
              <ul className="space-y-1">
                {artifacts.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-2.5 rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs text-zinc-200" title={a.name}>
                        {a.name}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        {a.kind} · {fmtBytes(a.size)}
                      </p>
                    </div>
                    <a
                      href={a.url ?? artifactDownloadUrl(a.id)}
                      download
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 py-2 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('buildDetail.download')}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function Builds() {
  const { t } = useTranslation();
  const { id: projectId } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [builds, setBuilds] = useState<BuildJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<BuildJob | null>(null);
  const [selectedTests, setSelectedTests] = useState<TestResult[]>([]);
  const [selectedReviews, setSelectedReviews] = useState<ReviewResult[]>([]);
  const [selectedArtifacts, setSelectedArtifacts] = useState<BuildArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [p, b] = await Promise.all([getProject(projectId), listBuilds(projectId)]);
        if (!cancelled) {
          setProject(p);
          setBuilds(b ?? []);
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
  }, [projectId]);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const [b, tr, rv, ar] = await Promise.all([
        getBuild(id),
        getBuildTests(id),
        getBuildReviews(id),
        getBuildArtifacts(id),
      ]);
      setSelected(b);
      setSelectedTests(tr ?? []);
      setSelectedReviews(rv ?? []);
      setSelectedArtifacts(ar ?? []);
    } catch {
      setSelected(null);
      setSelectedTests([]);
      setSelectedReviews([]);
      setSelectedArtifacts([]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // Escape closes the drawer.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

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
          {project?.name ?? '…'} — {t('studio.buildsPanel')}
        </h1>
      </div>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-16" role="status">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-500" aria-hidden="true" />
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : error ? (
          <EmptyState title={t('builds.loadError')} body={t('errors.network')} />
        ) : builds.length === 0 ? (
          <EmptyState title={t('builds.emptyTitle')} body={t('builds.emptyBody')} />
        ) : (
          <ol className="relative space-y-3 border-l border-zinc-800 pl-5">
            {builds.map((b) => (
              <li key={b.id} className="relative">
                <span
                  className="absolute -left-[26px] top-4 h-2.5 w-2.5 rounded-full bg-zinc-700 ring-4 ring-zinc-950"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => void openDetail(b.id)}
                  className="block w-full rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-left hover:border-zinc-700"
                  aria-label={`${t('buildDetail.title')} — ${b.status}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <StatusPill kind="build" status={b.status} />
                    <span className="font-mono text-xs text-zinc-500">
                      {t('builds.revision', { sha: b.revision_sha.slice(0, 7) })}
                    </span>
                  </div>
                  {b.verdict?.summary && (
                    <p className="mt-2 line-clamp-2 text-sm text-zinc-400">
                      {b.verdict.summary}
                    </p>
                  )}
                  <p className="mt-1.5 text-xs text-zinc-600">{fmtDateTime(b.created_at)}</p>
                </button>
              </li>
            ))}
          </ol>
        )}
      </main>

      {selectedId &&
        (detailLoading ? (
          <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
            role="status"
          >
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" aria-hidden="true" />
          </div>
        ) : selected ? (
          <BuildDetail
            build={selected}
            tests={selectedTests}
            reviews={selectedReviews}
            artifacts={selectedArtifacts}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
            role="alert"
          >
            <div className="rounded-xl bg-zinc-950 p-6 ring-1 ring-zinc-800">
              <p className="text-sm text-zinc-300">{t('buildDetail.loadError')}</p>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="mt-3 min-h-11 rounded-md bg-zinc-800 px-4 py-2 text-sm text-zinc-200"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
