import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Box,
  Check,
  Download,
  FileQuestion,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  assetDownloadUrl,
  deleteAsset,
  getProject,
  listAssets,
  uploadAsset,
  ApiError,
} from '../api/client';
import type { Asset, Project } from '../types';
import { Header } from '../components/Header';
import { EmptyState } from '../components/EmptyState';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const UPLOAD_KINDS = [
  'model',
  'material',
  'texture',
  'image',
  'sprite',
  'animation',
  'audio',
  'music',
  'video',
  'font',
  'other',
] as const;

function basename(path: string): string {
  const i = path.replace(/\\/g, '/').lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[u]}`;
}

function kindIcon(kind: string) {
  const cls = 'h-8 w-8';
  switch (kind) {
    case 'image':
      return <ImageIcon className={cls} aria-hidden="true" />;
    case 'audio':
      return <Music className={cls} aria-hidden="true" />;
    case 'model':
      return <Box className={cls} aria-hidden="true" />;
    case 'video':
      return <Film className={cls} aria-hidden="true" />;
    case 'font':
      return <FileText className={cls} aria-hidden="true" />;
    default:
      return <FileQuestion className={cls} aria-hidden="true" />;
  }
}

const STAGE_TONE: Record<string, string> = {
  unconfirmed: 'bg-zinc-800 text-zinc-400',
  integrated: 'bg-cyan-950 text-cyan-300',
  verified: 'bg-emerald-950 text-emerald-300',
};

export function Assets() {
  const { t } = useTranslation();
  const { id: projectId } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [uploadKind, setUploadKind] = useState<string>('auto');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadAssets = useCallback(async () => {
    if (!projectId) return;
    try {
      const a = await listAssets(projectId);
      setAssets(a.items ?? []);
      setError(false);
    } catch {
      setError(true);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await getProject(projectId);
        if (!cancelled) setProject(p);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const a = await listAssets(projectId);
        if (!cancelled) {
          setAssets(a.items ?? []);
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
  }, [projectId, loadAssets]);

  const doUpload = useCallback(
    async (files: FileList | File[]) => {
      if (!projectId || uploading) return;
      const list = Array.from(files);
      if (list.length === 0) return;
      setUploading(true);
      setUploadError(null);
      try {
        for (const f of list) {
          if (f.size > MAX_UPLOAD_BYTES) {
            throw new ApiError(413, {
              error: {
                code: 'payload_too_large',
                message: 'payload_too_large',
                requestId: 'n/a',
              },
            });
          }
          await uploadAsset(
            projectId,
            f,
            uploadKind === 'auto' ? undefined : uploadKind,
          );
        }
        await loadAssets();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'payload_too_large') {
          setUploadError(t('assets.uploadTooLarge'));
        } else {
          setUploadError(t('assets.uploadError'));
        }
      } finally {
        setUploading(false);
      }
    },
    [projectId, uploading, uploadKind, loadAssets, t],
  );

  const onDelete = useCallback(
    async (assetId: string) => {
      setDeleting(true);
      setDeleteError(null);
      try {
        await deleteAsset(assetId);
        setConfirmDeleteId(null);
        await loadAssets();
      } catch {
        setDeleteError(t('assets.deleteError'));
      } finally {
        setDeleting(false);
      }
    },
    [loadAssets, t],
  );

  const kinds = useMemo(
    () => Array.from(new Set(assets.map((a) => a.kind))).sort(),
    [assets],
  );
  const visible = kindFilter === 'all' ? assets : assets.filter((a) => a.kind === kindFilter);

  const kindLabel = (kind: string): string => {
    const known = ['image', 'audio', 'model', 'video', 'font'] as const;
    return (known as readonly string[]).includes(kind)
      ? t(`assets.kinds.${kind}`)
      : t('assets.kinds.other');
  };

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
          {project?.name ?? '…'} — {t('assets.title')}
        </h1>
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {/* Upload zone */}
        <section
          aria-label={t('assets.uploadTitle')}
          className={`mb-6 rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
            dragging
              ? 'border-cyan-500 bg-cyan-950/30'
              : 'border-zinc-800 bg-zinc-900/40'
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void doUpload(e.dataTransfer.files);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => {
              if (e.target.files) void doUpload(e.target.files);
              e.target.value = '';
            }}
            aria-label={t('assets.uploadBrowse')}
          />
          <Upload
            className="mx-auto mb-2 h-8 w-8 text-zinc-500"
            aria-hidden="true"
          />
          <p className="mb-1 text-sm font-medium text-zinc-200">
            {t('assets.uploadTitle')}
          </p>
          <p className="mb-3 text-xs text-zinc-500">{t('assets.uploadHint')}</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <label className="sr-only" htmlFor="upload-kind">
              {t('assets.uploadTitle')}
            </label>
            <select
              id="upload-kind"
              value={uploadKind}
              onChange={(e) => setUploadKind(e.target.value)}
              className="min-h-11 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300"
            >
              <option value="auto">{t('assets.uploadKindAuto')}</option>
              {UPLOAD_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`assets.kinds.${k}`, { defaultValue: k })}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              {uploading ? t('assets.uploading') : t('assets.uploadBrowse')}
            </button>
          </div>
          {uploadError && (
            <p className="mt-3 text-xs text-red-300" role="alert">
              {uploadError}
            </p>
          )}
        </section>

        {kinds.length > 1 && (
          <div
            className="mb-4 flex flex-wrap gap-2"
            role="group"
            aria-label={t('assets.filterByKind')}
          >
            {['all', ...kinds].map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKindFilter(k)}
                aria-pressed={kindFilter === k}
                className={`min-h-11 rounded-full px-4 py-2 text-sm font-medium sm:min-h-0 sm:py-1.5 ${
                  kindFilter === k
                    ? 'bg-cyan-600 text-white'
                    : 'bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200'
                }`}
              >
                {k === 'all' ? t('assets.filterAll') : kindLabel(k)}
              </button>
            ))}
          </div>
        )}

        {deleteError && (
          <p className="mb-4 text-xs text-red-300" role="alert">
            {deleteError}
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16" role="status">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-500" aria-hidden="true" />
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : error ? (
          <EmptyState title={t('assets.loadError')} body={t('errors.network')} />
        ) : visible.length === 0 ? (
          <EmptyState title={t('assets.emptyTitle')} body={t('assets.emptyBody')} />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {visible.map((a) => (
              <li
                key={a.id}
                className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/60 p-3"
              >
                <div className="mb-2 flex h-16 items-center justify-center rounded-lg bg-zinc-950/60 text-zinc-500">
                  {kindIcon(a.kind)}
                </div>
                <p className="truncate text-sm font-medium text-zinc-200" title={a.path}>
                  {basename(a.path)}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {kindLabel(a.kind)}
                  {a.format ? ` · ${a.format}` : ''} · {formatBytes(a.bytes)}
                </p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  {a.useStage && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        STAGE_TONE[a.useStage] ?? STAGE_TONE.unconfirmed
                      }`}
                    >
                      {t(`assets.stages.${a.useStage}`, {
                        defaultValue: a.useStage,
                      })}
                    </span>
                  )}
                  {a.contentHash && (
                    <span
                      className="truncate font-mono text-[11px] text-zinc-600"
                      title={a.contentHash}
                    >
                      {t('assets.hash', { hash: a.contentHash.slice(0, 8) })}
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-1 border-t border-zinc-800/70 pt-2">
                  <a
                    href={a.url ?? assetDownloadUrl(a.id)}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    download
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('assets.download')}
                  </a>
                  <div className="ml-auto">
                    {confirmDeleteId === a.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void onDelete(a.id)}
                          disabled={deleting}
                          className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                        >
                          {deleting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {t('assets.deleteConfirmAction')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="inline-flex min-h-11 items-center rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                          aria-label={t('common.cancel')}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(a.id)}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
                        aria-label={t('assets.deleteConfirm', { name: basename(a.path) })}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('assets.delete')}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
