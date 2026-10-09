import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ChevronRight,
  FolderOpen,
  Gamepad2,
  GitBranch,
  Hammer,
  LayoutDashboard,
  Loader2,
  MonitorPlay,
  Package,
  Send,
  Settings as SettingsIcon,
  Square,
} from 'lucide-react';
import {
  cancelRun,
  getProject,
  listBuilds,
  listMessages,
  listRuns,
  postMessage,
} from '../api/client';
import { useRunEvents } from '../api/sse';
import type {
  AgentEvent,
  AgentRun,
  BuildJob,
  ChatMessage,
  ExecutionModeValue,
  Project,
} from '../types';
import { Header } from '../components/Header';
import { StatusPill } from '../components/StatusPill';
import { EmptyState } from '../components/EmptyState';
import { CodeEditor } from '../components/code/CodeEditor';
import { QuestionCard, type QuestionPayload } from '../components/QuestionCard';
import { UpdatePrompt } from '../components/UpdatePrompt';

const TERMINAL = new Set(['completed', 'failed', 'canceled']);
type MobileTab = 'chat' | 'preview' | 'builds' | 'code' | 'more';

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function Studio() {
  const { t } = useTranslation();
  const { id: projectId } = useParams<{ id: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [builds, setBuilds] = useState<BuildJob[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [questions, setQuestions] = useState<QuestionPayload[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [composer, setComposer] = useState('');
  const [mode, setMode] = useState<ExecutionModeValue>('auto');
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat');
  const [rightTab, setRightTab] = useState<'preview' | 'builds' | 'code' | 'console'>('preview');
  const [previewKey, setPreviewKey] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const loadAll = useCallback(async () => {
    if (!projectId) return;
    try {
      const [p, msgs, r, b] = await Promise.all([
        getProject(projectId),
        listMessages(projectId),
        listRuns(projectId),
        listBuilds(projectId),
      ]);
      setProject(p);
      setMessages(msgs);
      setRuns(r);
      setBuilds(b);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [projectId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const activeRun = runs.find((r) => !TERMINAL.has(r.status)) ?? null;

  // Poll runs/builds while a run is active (SSE covers events; polling covers state).
  useEffect(() => {
    if (!activeRun || !projectId) return;
    const timer = window.setInterval(async () => {
      try {
        const [r, b] = await Promise.all([listRuns(projectId), listBuilds(projectId)]);
        setRuns(r);
        setBuilds(b);
      } catch {
        /* keep stale state; SSE errors surface separately */
      }
    }, 8000);
    return () => window.clearInterval(timer);
  }, [activeRun?.id, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSseEvent = useCallback((event: AgentEvent) => {
    setEvents((prev) => {
      if (prev.some((e) => e.seq === event.seq && e.run_id === event.run_id)) return prev;
      return [...prev.slice(-499), event];
    });
    if (event.kind === 'question_asked') {
      const q = (event.payload?.question ?? event.payload) as QuestionPayload;
      if (q && typeof q.question === 'string') {
        setQuestions((prev) => [...prev, q]);
        setRightTab('preview');
      }
    }
    if (event.kind === 'status_changed' && projectId) {
      void listRuns(projectId).then(setRuns).catch(() => {});
    }
  }, [projectId]);

  const { connected } = useRunEvents(activeRun?.id ?? null, handleSseEvent);

  // "/" focuses the composer; Escape blurs it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sendMessage = async (content: string) => {
    const text = content.trim();
    if (!text || !projectId || sending) return;
    setSending(true);
    try {
      const msg = await postMessage(projectId, { content: text, startRun: { mode } });
      setMessages((prev) => [...prev, msg]);
      setComposer('');
      const r = await listRuns(projectId);
      setRuns(r);
    } catch {
      setLoadError(true);
    } finally {
      setSending(false);
    }
  };

  const answerQuestion = (q: QuestionPayload, answerText: string) => {
    setQuestions((prev) => prev.filter((x) => x !== q));
    void sendMessage(answerText);
  };

  const stopRun = async () => {
    if (!activeRun || stopping) return;
    setStopping(true);
    try {
      const updated = await cancelRun(activeRun.id);
      setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch {
      // Surface honestly; the run may already be terminal.
      if (projectId) {
        try {
          setRuns(await listRuns(projectId));
        } catch {
          /* ignore */
        }
      }
    } finally {
      setStopping(false);
    }
  };

  const latestPreviewBuild = builds.find((b) => b.preview_url);

  const chatPanel = (
    <section
      aria-label={t('studio.chatTab')}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="rounded-lg border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
            {t('chat.empty')}
          </p>
        )}
        {messages.map((m) => (
          <article
            key={m.id}
            className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'ml-auto bg-cyan-950/60 text-zinc-100 ring-1 ring-cyan-800/40'
                : 'bg-zinc-900 text-zinc-200 ring-1 ring-zinc-800'
            }`}
          >
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              {m.role}
            </div>
            <p className="whitespace-pre-wrap">{m.content}</p>
          </article>
        ))}
        {questions.map((q, i) => (
          <QuestionCard
            key={`${q.questionId ?? 'q'}-${i}`}
            payload={q}
            disabled={sending}
            onAnswer={(text) => answerQuestion(q, text)}
          />
        ))}
      </div>

      <div className="border-t border-zinc-800 p-3">
        <div className="mb-2 flex items-center gap-2">
          <label htmlFor="run-mode" className="text-xs text-zinc-500">
            {t('chat.mode')}
          </label>
          <select
            id="run-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as ExecutionModeValue)}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
          >
            {(['manual', 'auto', 'loop'] as const).map((m) => (
              <option key={m} value={m}>
                {t(`chat.modes.${m}`)}
              </option>
            ))}
          </select>
          {!connected && activeRun && (
            <span className="text-xs text-amber-400" role="status">
              ●
            </span>
          )}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void sendMessage(composer);
          }}
        >
          <label htmlFor="composer" className="sr-only">
            {t('chat.send')}
          </label>
          <textarea
            id="composer"
            ref={composerRef}
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            placeholder={t('chat.placeholder')}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMessage(composer);
              }
              if (e.key === 'Escape') composerRef.current?.blur();
            }}
            className="flex-1 resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
          <button
            type="submit"
            disabled={sending || composer.trim().length === 0}
            className="inline-flex items-center gap-1.5 self-end rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            {sending ? t('chat.sending') : t('chat.send')}
          </button>
        </form>
      </div>
    </section>
  );

  const previewPanel = (
    <section aria-label={t('studio.previewPanel')} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {t('studio.previewPanel')}
        </span>
        {latestPreviewBuild?.preview_url && (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setPreviewKey((k) => k + 1)}
              className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              {t('preview.reload')}
            </button>
            <a
              href={latestPreviewBuild.preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              {t('preview.openStandalone')}
            </a>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 p-3">
        {latestPreviewBuild?.preview_url ? (
          <iframe
            key={previewKey}
            src={latestPreviewBuild.preview_url}
            title={t('studio.previewPanel')}
            // Opaque sandbox: the game runs isolated from the studio origin.
            // No API secrets or backend access reach this frame (ARCHITECTURE.md §8).
            sandbox="allow-scripts"
            allow="fullscreen"
            className="h-full min-h-64 w-full rounded-lg border border-zinc-800 bg-black"
          />
        ) : (
          <EmptyState
            icon={<MonitorPlay className="h-10 w-10" aria-hidden="true" />}
            title={t('preview.emptyTitle')}
            body={t('preview.emptyBody')}
          />
        )}
      </div>
    </section>
  );

  const buildsPanel = (
    <section aria-label={t('studio.buildsPanel')} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {t('studio.buildsPanel')}
        </span>
        {projectId && builds.length > 0 && (
          <Link
            to={`/projects/${projectId}/builds`}
            className="text-xs text-cyan-400 hover:text-cyan-300"
          >
            {t('builds.viewAll')}
          </Link>
        )}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {builds.length === 0 && (
          <EmptyState title={t('builds.emptyTitle')} body={t('builds.emptyBody')} />
        )}
        {builds.map((b) => (
          <article
            key={b.id}
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <StatusPill kind="build" status={b.status} />
              <span className="font-mono text-xs text-zinc-500">
                {b.revision_sha
                  ? t('builds.revision', { sha: b.revision_sha.slice(0, 7) })
                  : t('builds.noRevision')}
              </span>
            </div>
            {b.verdict?.summary && (
              <p className="mt-2 text-xs text-zinc-400">{b.verdict.summary}</p>
            )}
            <p className="mt-1 text-[11px] text-zinc-600">
              {t('builds.started', { date: fmtTime(b.created_at) })}
            </p>
          </article>
        ))}
      </div>
    </section>
  );

  const codePanel = (
    <section aria-label={t('studio.codePanel')} className="flex min-h-0 flex-1 flex-col">
      {projectId ? <CodeEditor projectId={projectId} /> : null}
    </section>
  );

  const consolePanel = (
    <section aria-label={t('studio.consolePanel')} className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {t('console.title')}
        </span>
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto p-3 font-mono text-xs">
        {events.length === 0 && (
          <p className="font-sans text-sm text-zinc-500">{t('console.empty')}</p>
        )}
        {events.map((e) => (
          <div
            key={`${e.run_id}:${e.seq}`}
            className="flex items-baseline gap-2 rounded border border-zinc-800/60 bg-zinc-900/40 px-2 py-1"
          >
            <span className="shrink-0 text-zinc-600">{fmtTime(e.created_at)}</span>
            <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-cyan-300">
              {e.kind}
            </span>
            <span className="truncate text-zinc-400">
              {typeof e.payload?.summary === 'string'
                ? e.payload.summary
                : `#${e.seq}`}
            </span>
          </div>
        ))}
      </div>
    </section>
  );

  const rightTabs = (
    <>
      <div className="flex shrink-0 gap-1 border-b border-zinc-800 px-2 pt-2" role="tablist">
        {(
          [
            ['preview', t('studio.previewPanel')],
            ['builds', t('studio.buildsPanel')],
            ['code', t('studio.codePanel')],
            ['console', t('studio.consolePanel')],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={rightTab === key}
            onClick={() => setRightTab(key)}
            className={`rounded-t-md px-3 py-1.5 text-xs font-medium ${
              rightTab === key
                ? 'bg-zinc-900 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-zinc-900/30">
        {rightTab === 'preview' && previewPanel}
        {rightTab === 'builds' && buildsPanel}
        {rightTab === 'code' && codePanel}
        {rightTab === 'console' && consolePanel}
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <Header />

      {/* Studio header: back, project, run status + stop */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <Link
          to="/"
          className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label={t('nav.back')}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
        <h1 className="truncate text-sm font-semibold">
          {project?.name ?? '…'}
        </h1>
        <div className="ml-auto flex items-center gap-2">
          {activeRun ? (
            <>
              <StatusPill kind="run" status={activeRun.status} />
              <button
                type="button"
                onClick={() => void stopRun()}
                disabled={stopping}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                aria-label={t('run.stop')}
              >
                {stopping ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {stopping ? t('run.stopping') : t('run.stop')}
              </button>
            </>
          ) : (
            <span className="text-xs text-zinc-500">{t('run.noActiveRun')}</span>
          )}
        </div>
      </div>

      {loadError && (
        <div className="border-b border-red-900/50 bg-red-950/30 px-4 py-2 text-sm text-red-300" role="alert">
          {t('errors.network')}{' '}
          <button
            type="button"
            onClick={() => void loadAll()}
            className="underline hover:text-red-200"
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* Mobile tab bar */}
      <nav
        className="flex shrink-0 gap-1 border-b border-zinc-800 px-2 py-2 lg:hidden"
        aria-label={t('studio.chatTab')}
      >
        {(
          [
            ['chat', t('studio.chatTab')],
            ['preview', t('studio.previewTab')],
            ['builds', t('studio.buildsTab')],
            ['code', t('studio.codePanel')],
            ['more', t('studio.moreTab')],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMobileTab(key)}
            aria-pressed={mobileTab === key}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
              mobileTab === key
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* Desktop: 3-pane grid · Mobile: single tabbed pane */}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(0,1fr)_380px]">
        {/* Left sidebar (desktop) */}
        <nav
          aria-label={t('nav.dashboard')}
          className="hidden min-h-0 flex-col gap-1 overflow-y-auto border-r border-zinc-800 p-3 lg:flex"
        >
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
            {t('nav.dashboard')}
          </Link>
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            <Package className="h-4 w-4" aria-hidden="true" />
            {t('nav.projects')}
          </Link>
          <Link
            to="/?new=1"
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            <Gamepad2 className="h-4 w-4" aria-hidden="true" />
            {t('nav.createGame')}
            <ChevronRight className="ml-auto h-4 w-4 text-zinc-600" aria-hidden="true" />
          </Link>
          {projectId && (
            <>
              <Link
                to={`/projects/${projectId}/assets`}
                className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                <FolderOpen className="h-4 w-4" aria-hidden="true" />
                {t('nav.assets')}
              </Link>
              <Link
                to={`/projects/${projectId}/builds`}
                className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                <Hammer className="h-4 w-4" aria-hidden="true" />
                {t('nav.buildsPage')}
              </Link>
              <Link
                to={`/projects/${projectId}/revisions`}
                className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                <GitBranch className="h-4 w-4" aria-hidden="true" />
                {t('nav.revisions')}
              </Link>
            </>
          )}
          <Link
            to="/settings"
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            <SettingsIcon className="h-4 w-4" aria-hidden="true" />
            {t('nav.settings')}
          </Link>

          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <p className="mb-1 text-xs font-semibold text-zinc-300">{t('roadmap.title')}</p>
            <p className="text-xs leading-relaxed text-zinc-500">{t('roadmap.body')}</p>
          </div>
        </nav>

        {/* Center: chat */}
        <div className="hidden min-h-0 flex-col border-r border-zinc-800 lg:flex">
          {chatPanel}
        </div>

        {/* Right: tabs */}
        <div className="hidden min-h-0 flex-col lg:flex">{rightTabs}</div>

        {/* Mobile: one pane at a time */}
        <div className="flex min-h-[60vh] flex-col lg:hidden">
          {mobileTab === 'chat' && chatPanel}
          {mobileTab === 'preview' && previewPanel}
          {mobileTab === 'code' && codePanel}
          {mobileTab === 'builds' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {buildsPanel}
              <div className="max-h-64 overflow-y-auto border-t border-zinc-800">
                {consolePanel}
              </div>
            </div>
          )}
          {mobileTab === 'more' && (
            <nav aria-label={t('studio.moreTab')} className="flex flex-col gap-1 p-3">
              {projectId && (
                <>
                  <Link
                    to={`/projects/${projectId}/assets`}
                    className="flex min-h-11 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200"
                  >
                    <FolderOpen className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                    {t('nav.assets')}
                  </Link>
                  <Link
                    to={`/projects/${projectId}/builds`}
                    className="flex min-h-11 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200"
                  >
                    <Hammer className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                    {t('nav.buildsPage')}
                  </Link>
                  <Link
                    to={`/projects/${projectId}/revisions`}
                    className="flex min-h-11 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200"
                  >
                    <GitBranch className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                    {t('nav.revisions')}
                  </Link>
                </>
              )}
              <Link
                to="/settings"
                className="flex min-h-11 items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-200"
              >
                <SettingsIcon className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                {t('nav.settings')}
              </Link>
            </nav>
          )}
        </div>
      </div>

      <UpdatePrompt />
    </div>
  );
}
