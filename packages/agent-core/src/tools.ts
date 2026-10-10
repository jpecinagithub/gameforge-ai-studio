/**
 * Tool registry for the director's tool loop.
 *
 * Every tool: zod-validated args (unknown tool names and bad args fail closed),
 * typed errors, and — for writeFile — a MANDATORY git checkpoint BEFORE the
 * write (REFERENCE_ANALYSIS.md F8: checkpoint before agent edits; never silently
 * overwrite). Optimistic concurrency via expectedCommitSha.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BuildStatus,
  relativePathSchema,
  type SecretRedactor,
} from '@gameforge/shared';
import { AgentCoreError, AgentCoreErrorCode, PauseForUser } from './errors.js';
import { StopCode } from '@gameforge/shared';
import { AGENT_ROLES, getRoleDef, type AgentRole } from './roles.js';
import { createRememberTool, type MemoryStore } from './memory.js';

/* ------------------------------------------------------------------ */
/* Phase 4: task dispatch                                               */
/* ------------------------------------------------------------------ */

/** Result of a synchronously-executed task dispatch (Phase 4). */
export interface TaskDispatchResult {
  taskId: string;
  status: string;
  summary: string;
}

/**
 * Task dispatcher (Phase 4). The orchestrator implements this: it creates the
 * task row, runs the role agent (synchronously in-process in Phase 4 —
 * BullMQ fan-out is a Phase 7 scaling optimization), merges validated
 * results, and returns the summary.
 */
export interface TaskDispatcherOps {
  dispatch(
    role: AgentRole,
    objective: string,
    dependsOn?: string[],
  ): Promise<TaskDispatchResult>;
}

/* ------------------------------------------------------------------ */
/* Context interfaces                                                  */
/* ------------------------------------------------------------------ */

/** Git operations the tools are allowed (narrow surface, implemented in git.ts). */
export interface GitOps {
  /** Commit current worktree state; returns the new HEAD SHA. */
  checkpoint(message: string): Promise<string>;
  /** Current HEAD SHA. */
  head(): Promise<string>;
  status(): Promise<{ clean: boolean; changed: string[] }>;
  diff(): Promise<string>;
}

/** Build queue operations (implemented by the worker layer). */
export interface BuildsOps {
  /** Enqueue a build for the current revision. Returns immediately. */
  enqueue(): Promise<{ buildId: string }>;
  status(buildId: string): Promise<{ status: BuildStatus; verdict?: unknown }>;
}

/**
 * Evidence pipeline summary. The real implementation lives in
 * @gameforge/test-runner (Phase 3); agent-core depends on this interface ONLY —
 * never on playwright or Chromium.
 */
export interface EvidenceSummary {
  buildId: string;
  screenshots: number;
  consoleErrors: number;
  blankDetected: boolean;
  notes: string[];
}

export interface EvidenceProvider {
  gather(buildId: string): Promise<EvidenceSummary>;
}

/** Durable event writes the tools perform (worker implements via appendEvent). */
export interface EventsOps {
  questionAsked(
    runId: string,
    questionId: string,
    question: string,
    options?: string[],
  ): Promise<void>;
  toolCall(runId: string, toolName: string, args: unknown): Promise<void>;
  toolResult(runId: string, toolName: string, ok: boolean, summary: string): Promise<void>;
}

export interface ToolContext {
  runId: string;
  /** Project the run belongs to (memory scoping, prompts). */
  projectId: string;
  /** Agent role executing this turn — used for plugin tool gating. */
  role?: AgentRole;
  workDir: string;
  git: GitOps;
  builds: BuildsOps;
  evidence: EvidenceProvider;
  events: EventsOps;
  redactor: SecretRedactor;
  /** Durable memory (project/run scopes). Agents never write studio scope. */
  memory: MemoryStore;
  /** Phase 4: task dispatcher. Present in multi-agent runs; absent in single-agent turns. */
  dispatcher?: TaskDispatcherOps;
}

/* ------------------------------------------------------------------ */
/* Tool definition                                                     */
/* ------------------------------------------------------------------ */

export interface ToolDef<TArgs = unknown> {
  name: string;
  description: string;
  /** zod schema for arg validation (fail closed). */
  schema: z.ZodType<TArgs>;
  /** Hand-written JSON Schema for the provider tool definition (no codegen dep). */
  parameters: Record<string, unknown>;
  execute: (args: TArgs, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Registry element type. The `any` is contained at this boundary: every call
 * goes through `executeToolCall`, which zod-validates args against the tool's
 * own schema before invoking `execute`. Runtime safety is preserved.
 */
export type AnyToolDef = ToolDef<any>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Resolve a validated relative path inside workDir; throws on escape. */
function resolveIn(workDir: string, rel: string): string {
  const abs = path.resolve(workDir, rel);
  const root = path.resolve(workDir) + path.sep;
  if (abs !== path.resolve(workDir) && !abs.startsWith(root)) {
    throw new AgentCoreError(
      AgentCoreErrorCode.TOOL_VALIDATION_FAILED,
      `Path escapes workDir: ${rel}`,
      StopCode.TOOL_PERMISSION_DENIED,
    );
  }
  return abs;
}

const MAX_READ_BYTES = 512 * 1024; // 512 KiB — tools read sources, not binaries

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const readFile: ToolDef<{ path: string }> = {
  name: 'readFile',
  description:
    'Read a text file from the project workdir. Path must be relative (e.g. "src/main.ts").',
  schema: z.object({ path: relativePathSchema }),
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Relative file path.' } },
    required: ['path'],
    additionalProperties: false,
  },
  async execute({ path: rel }, ctx) {
    const abs = resolveIn(ctx.workDir, rel);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new AgentCoreError(
        AgentCoreErrorCode.TOOL_EXECUTION_FAILED,
        `readFile: not a file: ${rel}`,
      );
    }
    if (stat.size > MAX_READ_BYTES) {
      throw new AgentCoreError(
        AgentCoreErrorCode.TOOL_EXECUTION_FAILED,
        `readFile: file too large (${stat.size} bytes): ${rel}`,
      );
    }
    return { path: rel, content: await fs.readFile(abs, 'utf8') };
  },
};

const writeFile: ToolDef<{ path: string; content: string; expectedCommitSha?: string }> = {
  name: 'writeFile',
  description:
    'Write (create or overwrite) a text file. ALWAYS creates a git checkpoint BEFORE writing. ' +
    'Pass expectedCommitSha for optimistic concurrency: if HEAD moved since you last read, ' +
    'the write is rejected with CONFLICT instead of silently overwriting.',
  schema: z.object({
    path: relativePathSchema,
    content: z.string().max(2_000_000),
    expectedCommitSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path.' },
      content: { type: 'string', description: 'Full new file content.' },
      expectedCommitSha: {
        type: 'string',
        description: '40-char HEAD SHA you based this edit on (optimistic concurrency).',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute({ path: rel, content, expectedCommitSha }, ctx) {
    // 1. Optimistic concurrency FIRST — never checkpoint-then-write over a moved HEAD.
    const headBefore = await ctx.git.head();
    if (expectedCommitSha && expectedCommitSha !== headBefore) {
      throw new AgentCoreError(
        AgentCoreErrorCode.CONFLICT,
        `writeFile CONFLICT on ${rel}: expected HEAD ${expectedCommitSha.slice(0, 12)} ` +
          `but HEAD is ${headBefore.slice(0, 12)}. Re-read the file and retry.`,
        StopCode.UNKNOWN,
        { path: rel, expectedCommitSha, actualHead: headBefore },
      );
    }
    // 2. Checkpoint BEFORE the write (F8). The checkpoint records pre-edit state.
    const checkpointSha = await ctx.git.checkpoint(`before agent edit ${rel}`);
    // 3. Then write.
    const abs = resolveIn(ctx.workDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { path: rel, checkpointSha, headBefore };
  },
};

const listFiles: ToolDef<{ dir?: string }> = {
  name: 'listFiles',
  description: 'List files under a directory of the project workdir (default: root).',
  schema: z.object({ dir: relativePathSchema.optional() }),
  parameters: {
    type: 'object',
    properties: { dir: { type: 'string', description: 'Relative directory.' } },
    additionalProperties: false,
  },
  async execute({ dir }, ctx) {
    const abs = resolveIn(ctx.workDir, dir ?? '.');
    const entries: string[] = [];
    async function walk(d: string, prefix: string): Promise<void> {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(d, e.name), rel);
        else entries.push(rel);
        if (entries.length > 2000) return;
      }
    }
    await walk(abs, dir ?? '');
    return { dir: dir ?? '.', files: entries };
  },
};

const execBuild: ToolDef<Record<string, never>> = {
  name: 'execBuild',
  description:
    'Enqueue a build of the current revision. Returns immediately with a buildId; ' +
    'use buildStatus to poll. Does NOT wait.',
  schema: z.object({}),
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const { buildId } = await ctx.builds.enqueue();
    await ctx.events.toolCall(ctx.runId, 'execBuild', { buildId });
    return { buildId };
  },
};

const buildStatus: ToolDef<{ buildId: string }> = {
  name: 'buildStatus',
  description:
    'Poll a build enqueued by execBuild. Returns status (queued/building/testing/verifying/verified/partial/failed/canceled) and the verdict when finished.',
  schema: z.object({ buildId: z.string().min(1).max(128) }),
  parameters: {
    type: 'object',
    properties: { buildId: { type: 'string' } },
    required: ['buildId'],
    additionalProperties: false,
  },
  async execute({ buildId }, ctx) {
    const s = await ctx.builds.status(buildId);
    return { buildId, status: s.status, verdict: s.verdict ?? null };
  },
};

const gatherEvidence: ToolDef<{ buildId: string }> = {
  name: 'gatherEvidence',
  description:
    'Run the deterministic evidence pipeline (seeded playthrough, screenshots, console capture, blank detection) for a finished build.',
  schema: z.object({ buildId: z.string().min(1).max(128) }),
  parameters: {
    type: 'object',
    properties: { buildId: { type: 'string' } },
    required: ['buildId'],
    additionalProperties: false,
  },
  async execute({ buildId }, ctx) {
    return ctx.evidence.gather(buildId);
  },
};

const askUser: ToolDef<{ question: string; options?: string[] }> = {
  name: 'askUser',
  description:
    'Ask the user a question when requirements are ambiguous. Ask INSTEAD of guessing. ' +
    'This pauses the run until the user answers (control flow, not an error).',
  schema: z.object({
    question: z.string().min(1).max(2000),
    options: z.array(z.string().min(1).max(200)).max(8).optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
    },
    required: ['question'],
    additionalProperties: false,
  },
  async execute({ question, options }, ctx) {
    const questionId = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await ctx.events.questionAsked(ctx.runId, questionId, question, options);
    // Typed control flow — the director rethrows untouched; the worker maps it
    // to waiting_for_user. Never an Error string.
    throw new PauseForUser(questionId);
  },
};

const FINISH_SENTINEL = 'finishRun';

const finishRun: ToolDef<{ summary: string }> = {
  name: 'finishRun',
  description:
    'Finish the run with a final summary. Only call after a build verdict of verified/partial ' +
    'from buildStatus, or state "incomplete verification" honestly in the summary.',
  schema: z.object({ summary: z.string().min(1).max(8000) }),
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false,
  },
  async execute({ summary }) {
    return { [FINISH_SENTINEL]: true, summary };
  },
};

const dispatchTask: ToolDef<{ role: AgentRole; objective: string; dependsOn?: string[] }> = {
  name: 'dispatchTask',
  description:
    'Dispatch a specialized sub-agent task (Phase 4 orchestration). The role agent ' +
    'runs with its restricted toolset in an isolated git worktree; its validated ' +
    'result is merged back. Roles: gameplay, scene_visual, ui, asset, qa, reviewer. ' +
    'CRITICAL: Dispatch tasks in dependency order. First dispatch independent tasks ' +
    '(no dependsOn), wait for their task IDs in the response, THEN dispatch dependent ' +
    'tasks using those exact IDs in dependsOn. NEVER use descriptions, names, or ' +
    'guessed IDs in dependsOn — only IDs returned by previous dispatchTask calls.',
  schema: z.object({
    role: z.enum(AGENT_ROLES),
    objective: z.string().min(1).max(2000),
    dependsOn: z.array(z.string().min(1).max(64)).max(16).optional(),
  }),
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: [...AGENT_ROLES], description: 'Specialist role.' },
      objective: { type: 'string', description: 'Concrete, bounded objective for the role agent.' },
      dependsOn: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must have completed first.',
      },
    },
    required: ['role', 'objective'],
    additionalProperties: false,
  },
  async execute({ role, objective, dependsOn }, ctx) {
    // Validate the role even before checking the dispatcher (fail closed).
    getRoleDef(role);
    if (!ctx.dispatcher) {
      throw new AgentCoreError(
        AgentCoreErrorCode.TOOL_EXECUTION_FAILED,
        'dispatchTask unavailable: this run has no task dispatcher (single-agent mode)',
        StopCode.TOOL_PERMISSION_DENIED,
        { role },
      );
    }
    return ctx.dispatcher.dispatch(role, objective, dependsOn);
  },
};

export const TOOLS: AnyToolDef[] = [
  readFile,
  writeFile,
  listFiles,
  execBuild,
  buildStatus,
  gatherEvidence,
  askUser,
  finishRun,
  createRememberTool(),
  dispatchTask,
];

export function isFinishResult(v: unknown): v is { finishRun: true; summary: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)[FINISH_SENTINEL] === true
  );
}

/** Look up a tool by name; unknown names fail closed with a typed error. */
export function getTool(name: string): AnyToolDef {
  return getToolFrom(TOOLS, name);
}

/** Restricted-registry lookup (Phase 4 roles). Same typed fail-closed behavior. */
export function getToolFrom(defs: AnyToolDef[], name: string): AnyToolDef {
  const t = defs.find((x) => x.name === name);
  if (!t) {
    throw new AgentCoreError(
      AgentCoreErrorCode.UNKNOWN_TOOL,
      `Unknown tool: ${name}`,
      StopCode.TOOL_PERMISSION_DENIED,
      { name },
    );
  }
  return t;
}

/** Tool definitions restricted to a role's allowedTools (order = registry order). */
export function toolDefsForRole(role: AgentRole): AnyToolDef[] {
  const allowed = new Set(getRoleDef(role).allowedTools);
  return TOOLS.filter((t) => allowed.has(t.name));
}

/**
 * Execute one tool call end-to-end: validate args, run, record events.
 * PauseForUser is rethrown untouched (control flow). Other errors are returned
 * to the caller so the director can surface them to the model as tool results.
 */
export async function executeToolCall(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  return executeToolCallWith(TOOLS, name, rawArgs, ctx);
}

/**
 * Execute one tool call against a restricted registry (Phase 4 roles).
 * Identical semantics to executeToolCall; unknown names fail closed with
 * UNKNOWN_TOOL — this is what keeps the reviewer read-only.
 */
export async function executeToolCallWith(
  defs: AnyToolDef[],
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = getToolFrom(defs, name);
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new AgentCoreError(
      AgentCoreErrorCode.TOOL_VALIDATION_FAILED,
      `Tool "${name}" args failed validation: ${parsed.error.message}`,
      StopCode.TOOL_PERMISSION_DENIED,
      { name },
    );
  }
  await ctx.events.toolCall(ctx.runId, name, ctx.redactor.redactDeep(parsed.data));
  try {
    const result = await tool.execute(parsed.data, ctx);
    await ctx.events.toolResult(ctx.runId, name, true, summarize(result));
    return result;
  } catch (err) {
    if (err instanceof PauseForUser) throw err; // control flow, not failure
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.events.toolResult(ctx.runId, name, false, msg.slice(0, 500));
    throw err;
  }
}

function summarize(v: unknown): string {
  if (isFinishResult(v)) return `finishRun: ${v.summary.slice(0, 200)}`;
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? s.slice(0, 500) + '…' : s;
  } catch {
    return String(v).slice(0, 500);
  }
}

/** Convert the registry to provider tool definitions (hand-written JSON Schemas). */
export function toProviderTools(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return toProviderToolsFor(TOOLS);
}

/** Provider tool definitions for a restricted registry (Phase 4 roles). */
export function toProviderToolsFor(
  defs: AnyToolDef[],
): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return defs.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
