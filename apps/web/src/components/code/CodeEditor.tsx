import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react';
import {
  AlertTriangle,
  FileCode2,
  Files,
  GitCompare,
  Loader2,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';
import { ApiError } from '../../api/client';
import {
  ConflictError,
  getFile,
  listFiles,
  saveFile,
  type ProjectFileEntry,
} from '../../api/files';
import { languageForPath } from '../../api/languages';
import { useUiStore } from '../../store';
import { EmptyState } from '../EmptyState';
import { FileExplorer } from './FileExplorer';

interface OpenFile {
  content: string;
  savedContent: string;
  sha: string | null;
  commitSha: string | null;
  binary: boolean;
  loading: boolean;
}

interface DiffView {
  original: string;
  modified: string;
  title: string;
}

const SMALL_SCREEN =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(max-width: 1023px)').matches;

export function CodeEditor({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { theme } = useUiStore();

  const [files, setFiles] = useState<ProjectFileEntry[] | null>(null);
  const [filesError, setFilesError] = useState(false);
  const [openFiles, setOpenFiles] = useState<Map<string, OpenFile>>(new Map());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{
    serverContent: string;
    currentSha: string;
  } | null>(null);
  const [diffView, setDiffView] = useState<DiffView | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<(overwrite?: boolean) => Promise<void>>(async () => {});
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const active: OpenFile | null = activePath ? (openFiles.get(activePath) ?? null) : null;
  const dirty = active !== null && !active.binary && active.content !== active.savedContent;
  const language = activePath ? languageForPath(activePath) : 'plaintext';

  const loadFiles = useCallback(async () => {
    try {
      setFiles(await listFiles(projectId));
      setFilesError(false);
    } catch {
      setFilesError(true);
    }
  }, [projectId]);

  useEffect(() => {
    setFiles(null);
    setOpenFiles(new Map());
    setActivePath(null);
    setConflict(null);
    setDiffView(null);
    setFileError(null);
    setSaveError(null);
    void loadFiles();
  }, [loadFiles]);

  const openFile = useCallback(
    async (path: string) => {
      setActivePath(path);
      setExplorerOpen(false);
      setFileError(null);
      if (openFiles.has(path)) return;
      setOpenFiles((prev) => {
        const next = new Map(prev);
        next.set(path, {
          content: '',
          savedContent: '',
          sha: null,
          commitSha: null,
          binary: false,
          loading: true,
        });
        return next;
      });
      try {
        const fc = await getFile(projectId, path);
        setOpenFiles((prev) => {
          const next = new Map(prev);
          next.set(path, {
            content: fc.content,
            savedContent: fc.content,
            sha: fc.sha,
            commitSha: null,
            binary: false,
            loading: false,
          });
          return next;
        });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'binary_file') {
          setOpenFiles((prev) => {
            const next = new Map(prev);
            next.set(path, {
              content: '',
              savedContent: '',
              sha: null,
              commitSha: null,
              binary: true,
              loading: false,
            });
            return next;
          });
        } else {
          setFileError(t('code.loadFileError'));
          setOpenFiles((prev) => {
            const next = new Map(prev);
            next.delete(path);
            return next;
          });
          setActivePath((cur) => (cur === path ? null : cur));
        }
      }
    },
    [projectId, openFiles, t],
  );

  const closeFile = useCallback(
    (path: string) => {
      const entry = openFiles.get(path);
      if (entry && !entry.binary && entry.content !== entry.savedContent) {
        if (!window.confirm(t('code.confirmCloseUnsaved', { path }))) return;
      }
      setOpenFiles((prev) => {
        const next = new Map(prev);
        next.delete(path);
        return next;
      });
      setActivePath((cur) => {
        if (cur !== path) return cur;
        const remaining = [...openFiles.keys()].filter((p) => p !== path);
        return remaining.length > 0 ? remaining[remaining.length - 1]! : null;
      });
      setConflict(null);
      setDiffView(null);
    },
    [openFiles, t],
  );

  const save = useCallback(
    async (overwrite = false) => {
      if (!activePath || !active || active.binary || active.loading || saving) return;
      if (!dirty && !overwrite) return;
      setSaving(true);
      setSaveError(null);
      try {
        const res = await saveFile(
          projectId,
          activePath,
          active.content,
          overwrite ? undefined : (active.sha ?? undefined),
        );
        setOpenFiles((prev) => {
          const next = new Map(prev);
          const entry = next.get(activePath);
          if (entry) {
            next.set(activePath, {
              ...entry,
              savedContent: entry.content,
              sha: res.sha,
              commitSha: res.commitSha,
            });
          }
          return next;
        });
        setConflict(null);
        // Refresh sizes in the explorer without a loading flash.
        void listFiles(projectId)
          .then(setFiles)
          .catch(() => {});
      } catch (e) {
        if (e instanceof ConflictError) {
          try {
            const fresh = await getFile(projectId, activePath);
            setOpenFiles((prev) => {
              const next = new Map(prev);
              const entry = next.get(activePath);
              if (entry) next.set(activePath, { ...entry, sha: fresh.sha });
              return next;
            });
            setConflict({ serverContent: fresh.content, currentSha: e.currentSha || fresh.sha });
          } catch {
            setSaveError(t('code.saveFailed'));
          }
        } else {
          setSaveError(t('code.saveFailed'));
        }
      } finally {
        setSaving(false);
      }
    },
    [projectId, activePath, active, dirty, saving, t],
  );

  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const revert = useCallback(() => {
    if (!activePath || !active || active.binary) return;
    setOpenFiles((prev) => {
      const next = new Map(prev);
      const entry = next.get(activePath);
      if (entry) next.set(activePath, { ...entry, content: entry.savedContent });
      return next;
    });
    setSaveError(null);
  }, [activePath, active]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!activePath || value === undefined) return;
      setOpenFiles((prev) => {
        const next = new Map(prev);
        const entry = next.get(activePath);
        if (entry) next.set(activePath, { ...entry, content: value });
        return next;
      });
    },
    [activePath],
  );

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addAction({
      id: 'gameforge-save-file',
      label: 'Save file',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void saveRef.current(false);
      },
    });
  };

  // Ctrl/Cmd+S when focus is outside the editor (e.g. the explorer).
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current(false);
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  // Escape closes the diff view or the conflict dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (diffView) setDiffView(null);
        else if (conflict) setConflict(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [diffView, conflict]);

  const resolveConflictReload = () => {
    if (!activePath || !conflict) return;
    setOpenFiles((prev) => {
      const next = new Map(prev);
      const entry = next.get(activePath);
      if (entry) {
        next.set(activePath, {
          ...entry,
          content: conflict.serverContent,
          savedContent: conflict.serverContent,
          sha: conflict.currentSha,
        });
      }
      return next;
    });
    setConflict(null);
    setSaveError(null);
  };

  const editorOptions = useMemo(
    () => ({
      minimap: { enabled: !SMALL_SCREEN },
      fontSize: 13,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 8 },
      renderWhitespace: 'selection' as const,
    }),
    [],
  );

  const tabs = [...openFiles.keys()];

  return (
    <div ref={panelRef} className="flex min-h-0 flex-1 flex-col" aria-label={t('code.editorLabel')}>
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setExplorerOpen((v) => !v)}
          className={`rounded-md p-1.5 ${explorerOpen ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
          aria-label={t('code.toggleExplorer')}
          aria-pressed={explorerOpen}
          title={t('code.toggleExplorer')}
        >
          <Files className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label={t('code.openFiles')}>
          {tabs.map((p) => {
            const entry = openFiles.get(p);
            const isDirty = entry && !entry.binary && entry.content !== entry.savedContent;
            const isActive = p === activePath;
            return (
              <div
                key={p}
                role="tab"
                aria-selected={isActive}
                className={`flex shrink-0 items-center gap-1 rounded-t-md px-2 py-1 text-xs ${
                  isActive ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setActivePath(p)}
                  className="flex items-center gap-1.5"
                  title={p}
                >
                  <span className="max-w-32 truncate">{p.split('/').pop()}</span>
                  {isDirty && (
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-label={t('code.unsaved')} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => closeFile(p)}
                  className="rounded p-0.5 text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
                  aria-label={t('code.closeFile', { path: p })}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
        {active && !active.binary && (
          <>
            <button
              type="button"
              onClick={() => setDiffView({ original: active.savedContent, modified: active.content, title: t('code.compareSaved') })}
              disabled={!dirty}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
              aria-label={t('code.compareSaved')}
              title={t('code.compareSaved')}
            >
              <GitCompare className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={revert}
              disabled={!dirty}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
              aria-label={t('code.revert')}
              title={t('code.revert')}
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => void save(false)}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-cyan-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Save className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {saving ? t('code.saving') : t('code.save')}
            </button>
          </>
        )}
      </div>

      {saveError && (
        <div className="shrink-0 border-b border-red-900/50 bg-red-950/30 px-3 py-1.5 text-xs text-red-300" role="alert">
          {saveError}
          <button type="button" onClick={() => setSaveError(null)} className="ml-2 underline hover:text-red-200">
            {t('common.close')}
          </button>
        </div>
      )}
      {fileError && (
        <div className="shrink-0 border-b border-red-900/50 bg-red-950/30 px-3 py-1.5 text-xs text-red-300" role="alert">
          {fileError}
          <button type="button" onClick={() => setFileError(null)} className="ml-2 underline hover:text-red-200">
            {t('common.close')}
          </button>
        </div>
      )}

      {/* Main area */}
      <div className="relative flex min-h-0 flex-1">
        {explorerOpen && (
          <aside
            className="absolute inset-y-0 left-0 z-10 w-64 border-r border-zinc-800 bg-zinc-950"
            aria-label={t('code.fileExplorer')}
          >
            {files === null ? (
              <div className="flex items-center justify-center p-6">
                {filesError ? (
                  <div className="text-center">
                    <p className="mb-2 text-xs text-red-300">{t('code.loadFilesError')}</p>
                    <button type="button" onClick={() => void loadFiles()} className="text-xs text-cyan-400 underline">
                      {t('common.retry')}
                    </button>
                  </div>
                ) : (
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-500" aria-hidden="true" />
                )}
              </div>
            ) : (
              <FileExplorer files={files} selectedPath={activePath} onSelect={(p) => void openFile(p)} />
            )}
          </aside>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {diffView ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-1.5">
                <span className="truncate text-xs text-zinc-400">{diffView.title}</span>
                <button
                  type="button"
                  onClick={() => setDiffView(null)}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  aria-label={t('common.close')}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <DiffEditor
                  original={diffView.original}
                  modified={diffView.modified}
                  language={language}
                  theme={theme === 'dark' ? 'vs-dark' : 'vs'}
                  options={{ ...editorOptions, readOnly: true }}
                />
              </div>
            </div>
          ) : !active ? (
            <EmptyState
              icon={<FileCode2 className="h-10 w-10" aria-hidden="true" />}
              title={t('code.selectFile')}
              body={t('code.selectFileBody')}
            />
          ) : active.loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-500" aria-hidden="true" />
            </div>
          ) : active.binary ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="max-w-xs text-center">
                <FileCode2 className="mx-auto mb-3 h-10 w-10 text-zinc-600" aria-hidden="true" />
                <p className="mb-1 text-sm font-medium text-zinc-300">{t('code.binaryTitle')}</p>
                <p className="mb-2 font-mono text-xs text-zinc-500">{activePath}</p>
                <p className="text-xs text-zinc-500">{t('code.binaryBody')}</p>
              </div>
            </div>
          ) : (
            <Editor
              height="100%"
              path={activePath ?? undefined}
              language={language}
              value={active.content}
              theme={theme === 'dark' ? 'vs-dark' : 'vs'}
              options={editorOptions}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              loading={<Loader2 className="h-6 w-6 animate-spin text-zinc-500" aria-hidden="true" />}
            />
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-3 border-t border-zinc-800 px-3 py-1 text-[11px] text-zinc-500">
        <span className="truncate font-mono" title={activePath ?? ''}>
          {activePath ?? '—'}
        </span>
        <span className="ml-auto shrink-0">{language}</span>
        {active && !active.binary && !active.loading && (
          <span className={`shrink-0 ${dirty ? 'text-amber-400' : 'text-zinc-500'}`}>
            {dirty ? `● ${t('code.unsaved')}` : t('code.saved')}
          </span>
        )}
        {active?.commitSha && (
          <span className="shrink-0 font-mono" title={active.commitSha}>
            {t('code.commit', { sha: active.commitSha.slice(0, 7) })}
          </span>
        )}
      </div>

      {/* Conflict dialog */}
      {conflict && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="conflict-title"
        >
          <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
            <div className="mb-2 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-400" aria-hidden="true" />
              <h2 id="conflict-title" className="text-sm font-semibold text-zinc-100">
                {t('code.conflictTitle')}
              </h2>
            </div>
            <p className="mb-4 text-sm leading-relaxed text-zinc-400">{t('code.conflictBody')}</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() =>
                  active &&
                  setDiffView({
                    original: conflict.serverContent,
                    modified: active.content,
                    title: t('code.conflictDiffTitle'),
                  })
                }
                className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                {t('code.showDiff')}
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={resolveConflictReload}
                  className="flex-1 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
                >
                  {t('code.reloadTheirs')}
                </button>
                <button
                  type="button"
                  onClick={() => void save(true)}
                  className="flex-1 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-500"
                >
                  {t('code.overwriteMine')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
