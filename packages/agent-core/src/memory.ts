/**
 * Memory system — project/studio/run memory with relevance retrieval.
 *
 * Scopes (see migrations/0001_init.sql `memories`):
 * - 'run'     — ephemeral, tied to one agent run (working notes, decisions).
 * - 'project' — durable per-project facts (conventions, user preferences,
 *               gotchas discovered while building this game).
 * - 'studio'  — global studio knowledge (cross-project learnings). Agents can
 *               READ studio memories but never WRITE them: studio writes go
 *               through the API (human/API-only), so one run cannot poison
 *               global knowledge.
 *
 * The pg implementation lives in apps/worker (worker wiring); this module
 * holds the store interface, the pure deterministic ranking, prompt
 * formatting, and the `remember` tool definition.
 */
import { z } from 'zod';
import type { SecretRedactor } from '@gameforge/shared';
import { AgentCoreError, AgentCoreErrorCode } from './errors.js';
import type { ToolDef } from './tools.js';

export type MemoryScope = 'project' | 'studio' | 'run';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  runId: string | null;
  key: string;
  content: string;
  salience: number;
  version: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface MemoryWriteInput {
  scope: MemoryScope;
  projectId?: string | null;
  runId?: string | null;
  key: string;
  content: string;
  salience?: number;
}

/**
 * Persistence boundary. pg implementation in apps/worker/src/memoryStore.ts.
 * No pg import here — agent-core stays DB-agnostic (same discipline as the
 * evidence provider in tools.ts).
 */
export interface MemoryStore {
  write(input: MemoryWriteInput): Promise<MemoryRecord>;
  supersede(id: string, content: string, salience?: number): Promise<MemoryRecord>;
  listCurrent(scope: MemoryScope, projectId?: string | null): Promise<MemoryRecord[]>;
  search(
    scope: MemoryScope,
    projectId: string | null | undefined,
    query: string,
    limit: number,
  ): Promise<MemoryRecord[]>;
}

/* ------------------------------------------------------------------ */
/* Relevance ranking — pure, deterministic                              */
/* ------------------------------------------------------------------ */

const STOPWORDS: ReadonlySet<string> = new Set(
  'a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,your,their,my,me,him,us,do,does,did,not,no,yes,can,could,should,would,will,just,so,than,too,very,how,what,when,where,which,who,whom,why,into,over,under,again,once,all,any,both,each,few,more,most,other,some,such,only,own,same,also,during,between,through,before,after,above,below,up,down,out,off,about'.split(
    ',',
  ),
);

/** Significant tokens: lowercase, alphanumeric, len>=3, no stopwords. */
export function significantTokens(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  ).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Recency in [0,1]: exponential decay with a 30-day half-life-ish scale. */
export function recencyScore(updatedAtIso: string, nowMs: number): number {
  const t = Date.parse(updatedAtIso);
  if (Number.isNaN(t)) return 0;
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  return Math.exp(-ageDays / 30);
}

/**
 * Deterministic relevance score. Weights (documented, fixed):
 *   salience * 0.5 + recency * 0.2 + keywordOverlap * 0.3
 * keywordOverlap = |queryTokens ∩ contentTokens| / |queryTokens| (0 when the
 * query has no significant tokens — then salience+recency decide).
 */
export function scoreMemory(
  record: MemoryRecord,
  queryTokens: string[],
  nowMs: number,
): number {
  const saliencePart = Math.min(1, Math.max(0, record.salience)) * 0.5;
  const recencyPart = recencyScore(record.updatedAt, nowMs) * 0.2;
  let keywordPart = 0;
  if (queryTokens.length > 0) {
    const contentTokens = new Set(significantTokens(record.content + ' ' + record.key));
    const hits = queryTokens.filter((t) => contentTokens.has(t)).length;
    keywordPart = (hits / queryTokens.length) * 0.3;
  }
  return saliencePart + recencyPart + keywordPart;
}

export interface RankOptions {
  limit?: number;
  nowMs?: number;
}

/** Pure ranking over candidate records. Ties broken by updatedAt desc, then key. */
export function rankMemories(
  records: MemoryRecord[],
  query: string,
  opts: RankOptions = {},
): MemoryRecord[] {
  const nowMs = opts.nowMs ?? Date.now();
  const queryTokens = significantTokens(query);
  const scored = records.map((r) => ({ r, s: scoreMemory(r, queryTokens, nowMs) }));
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (b.r.updatedAt !== a.r.updatedAt) return b.r.updatedAt < a.r.updatedAt ? 1 : -1;
    return a.r.key < b.r.key ? -1 : a.r.key > b.r.key ? 1 : 0;
  });
  const limit = opts.limit ?? 8;
  return scored.slice(0, Math.max(0, limit)).map((x) => x.r);
}

export interface RetrieveOptions {
  /** One scope or 'all' (studio → project → run merged, then ranked). */
  scope: MemoryScope | 'all';
  projectId?: string | null;
  runId?: string | null;
  query: string;
  limit?: number;
  nowMs?: number;
}

/**
 * Fetch current memories across scopes and rank them by relevance.
 * Run-scoped memories are filtered to this run; project memories to this
 * project; studio memories are global.
 */
export async function relevanceRetrieve(
  store: MemoryStore,
  opts: RetrieveOptions,
): Promise<MemoryRecord[]> {
  const scopes: MemoryScope[] =
    opts.scope === 'all' ? ['studio', 'project', 'run'] : [opts.scope];
  const lists = await Promise.all(
    scopes.map((s) =>
      store.listCurrent(s, s === 'studio' ? null : (opts.projectId ?? null)),
    ),
  );
  const merged = lists.flat().filter((m) => {
    if (m.scope === 'run') return opts.runId == null || m.runId === opts.runId;
    if (m.scope === 'project')
      return opts.projectId == null || m.projectId === opts.projectId;
    return true;
  });
  return rankMemories(merged, opts.query, { limit: opts.limit ?? 8, nowMs: opts.nowMs });
}

/* ------------------------------------------------------------------ */
/* Prompt formatting                                                    */
/* ------------------------------------------------------------------ */

/** Compact block for prompt injection. Returns '' when there are no memories. */
export function formatMemoriesForPrompt(memories: MemoryRecord[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map(
    (m) => `<memory scope="${m.scope}" key="${escapeAttr(m.key)}">${m.content}</memory>`,
  );
  return `Relevant memories (project/studio/run knowledge — prefer these over re-deriving):\n${lines.join('\n')}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* remember tool                                                        */
/* ------------------------------------------------------------------ */

export const REMEMBER_MAX_KEY = 120;
export const REMEMBER_MAX_CONTENT = 8000;

/**
 * The agent-facing memory write tool. Agents may write 'run' and 'project'
 * memories only — 'studio' writes are API-only (human), so a run cannot
 * poison global knowledge. Content is redacted before write (secrets must
 * never land in memory rows — ARCHITECTURE.md §5 redaction-on-append).
 */
export const rememberArgsSchema = z.object({
  scope: z.enum(['run', 'project']),
  key: z.string().min(1).max(REMEMBER_MAX_KEY),
  content: z.string().min(1).max(REMEMBER_MAX_CONTENT),
  salience: z.number().min(0).max(1).optional(),
});

/** Context surface the remember tool needs (subset of ToolContext). */
export interface RememberContext {
  runId: string;
  projectId: string;
  redactor: SecretRedactor;
  memory: MemoryStore;
}

export async function executeRemember(
  args: z.infer<typeof rememberArgsSchema>,
  ctx: RememberContext,
): Promise<{ id: string; scope: string; key: string; version: number }> {
  const content = ctx.redactor.redactDeep(args.content);
  const rec = await ctx.memory.write({
    scope: args.scope,
    projectId: args.scope === 'project' ? ctx.projectId : null,
    runId: args.scope === 'run' ? ctx.runId : null,
    key: args.key,
    content,
    salience: args.salience ?? 0.5,
  });
  return { id: rec.id, scope: rec.scope, key: rec.key, version: rec.version };
}

/**
 * ToolDef for registration in tools.ts TOOLS. execute() requires the full
 * ToolContext; the typed subset above keeps the core logic testable.
 */
export function createRememberTool(): ToolDef<z.infer<typeof rememberArgsSchema>> {
  return {
    name: 'remember',
    description:
      'Save a durable memory for this run or project (conventions, user preferences, ' +
      'gotchas discovered). scope "run" = this run only; "project" = future runs of this ' +
      'project. Keep content short and factual. Studio-wide memories are API-only.',
    schema: rememberArgsSchema,
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['run', 'project'],
          description: 'run = this run only; project = durable for this project.',
        },
        key: {
          type: 'string',
          description: 'Short stable key, e.g. "prefers-dark-ui" (1-120 chars).',
        },
        content: {
          type: 'string',
          description: 'Factual content (1-8000 chars). Never include secrets.',
        },
        salience: {
          type: 'number',
          description: 'Importance 0-1 (default 0.5). Higher = retrieved more often.',
        },
      },
      required: ['scope', 'key', 'content'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      if (!ctx.memory) {
        throw new AgentCoreError(
          AgentCoreErrorCode.TOOL_EXECUTION_FAILED,
          'remember: memory store unavailable in this context',
        );
      }
      return executeRemember(args, {
        runId: ctx.runId,
        projectId: ctx.projectId,
        redactor: ctx.redactor,
        memory: ctx.memory,
      });
    },
  };
}
