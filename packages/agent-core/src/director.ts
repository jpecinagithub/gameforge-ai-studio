/**
 * Director turn: one provider tool-calling session driving the tool loop.
 *
 * Adapted from the Genex director/wake pattern (REFERENCE_ANALYSIS.md F2):
 * the director makes decisions through tools; each wake rehydrates state from
 * the run journal (the worker owns that — here we run ONE turn of up to
 * maxRounds tool-call rounds). Workers AI has no sessions, so all state the model
 * needs travels in `messages`.
 *
 * Control flow:
 * - askUser → PauseForUser propagates untouched (worker → waiting_for_user).
 * - Budget breach → BudgetExhaustedError propagates typed (worker → failed w/ code).
 * - maxRounds → typed ITERATION_BUDGET_EXHAUSTED.
 * - finishRun tool → clean return with the model's summary.
 */
import { StopCode } from '@gameforge/shared';
import {
  computeCost,
  BudgetTracker,
  CloudflareClient,
  type AlibabaClient,
  ModelRegistry,
  type ChatMessage,
} from '@gameforge/model-providers';
import {
  AgentCoreError,
  AgentCoreErrorCode,
  isPauseForUser,
} from './errors.js';
import {
  executeToolCall,
  executeToolCallWith,
  isFinishResult,
  toProviderTools,
  toProviderToolsFor,
  toolDefsForRole,
  TOOLS,
  type AnyToolDef,
  type ToolContext,
} from './tools.js';
import { DIRECTOR_SYSTEM_PROMPT } from './prompts.js';
import { getRoleDef, type AgentRole } from './roles.js';

export interface DirectorTurnOptions {
  runId: string;
  workDir: string;
  ctx: ToolContext;
  provider: CloudflareClient | AlibabaClient;
  registry: ModelRegistry;
  budgets: BudgetTracker;
  /** The user's natural-language request (and any follow-up). */
  userRequest: string;
  /** Prior conversation messages (rehydrated from DB by the worker). */
  history?: ChatMessage[];
  maxRounds?: number;
  /**
   * Optional cooperative abort hook. Return a StopCode to abort the turn
   * (pause/cancel requested); return null to continue. Checked every round.
   */
  shouldAbort?: () => Promise<StopCode | null>;
}

export interface DirectorTurnResult {
  summary: string;
  stepsTaken: number;
  tokensUsed: number;
  /** True when the model called finishRun; false when it just stopped calling tools. */
  finished: boolean;
}

/**
 * Generic agent turn (Phase 4). runDirectorTurn delegates with the director
 * role's prompt, full tool registry, and director model selection — identical
 * behavior to Phase 3. Role agents pass their restricted prompt + tool subset.
 */
export interface AgentTurnOptions extends Omit<DirectorTurnOptions, 'userRequest'> {
  /** System prompt (role prompt with version tag). */
  systemPrompt: string;
  /** Restricted tool registry for this role. */
  toolDefs: AnyToolDef[];
  /** Model selection key (capability-based, never a model name). */
  modelRole: string;
  requiresTools?: boolean;
  /** Prefer larger-context models (planning/reasoning roles). */
  preferLargeModel?: boolean;
  /** The task/objective text (user-role message). */
  objective: string;
}

export async function runAgentTurn(
  opts: AgentTurnOptions,
): Promise<DirectorTurnResult> {
  const {
    ctx,
    provider,
    registry,
    budgets,
    systemPrompt,
    toolDefs,
    modelRole,
    objective,
    maxRounds = DEFAULT_MAX_ROUNDS,
  } = opts;

  // Capability-gated model selection — no model names in this logic.
  const model = registry.selectModel({
    role: modelRole,
    requiresTools: opts.requiresTools ?? true,
    preferLarge: opts.preferLargeModel ?? false,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(opts.history ?? []),
    { role: 'user', content: objective },
  ];

  let stepsTaken = 0;
  // Consecutive text-only responses: the model is not acting through tools.
  // Nudge it a few times before giving up the turn as unfinished.
  let textOnlyStrikes = 0;
  const MAX_TEXT_ONLY_STRIKES = 3;

  for (let round = 1; round <= maxRounds; round++) {
    const abort = await opts.shouldAbort?.();
    if (abort) {
      throw new AgentCoreError(
        AgentCoreErrorCode.ABORTED,
        `Agent turn aborted by worker: ${abort}`,
        abort,
      );
    }
    budgets.checkTime();

    const res = await provider.chatCompletions({
      model,
      messages,
      tools: toProviderToolsFor(toolDefs),
      toolChoice: 'auto',
    });

    // Token accounting is load-bearing (Workers AI is always metered).
    const costUsd = computeCost(model, res.usage.inputTokens, res.usage.outputTokens);
    budgets.recordUsage({
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd,
    });

    if (res.toolCalls.length === 0) {
      textOnlyStrikes += 1;
      if (textOnlyStrikes >= MAX_TEXT_ONLY_STRIKES) {
        return {
          summary: res.content ?? '',
          stepsTaken,
          tokensUsed: budgets.snapshot().usedTokens,
          finished: false,
        };
      }
      // Text-only response: nudge the model to act through tools instead of
      // ending the turn with zero progress.
      messages.push({
        role: 'user',
        content:
          'That response made no progress toward the objective. You must call one of the available tools to advance the task — text alone does not count. Call the appropriate tool now.',
      });
      continue;
    }
    textOnlyStrikes = 0;

    // Echo the assistant's tool calls back. Cloudflare's chat completions
    // validation is strict: when tool_calls are present, content MUST be null
    // (not the model's text). OpenAI tolerates both; Cloudflare 400s otherwise.
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: res.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    } as ChatMessage);

    for (const call of res.toolCalls) {
      stepsTaken += 1;
      let result: unknown;
      try {
        result = await executeToolCallWith(toolDefs, call.name, call.arguments, ctx);
      } catch (err) {
        if (isPauseForUser(err)) throw err; // control flow — never swallowed
        const code = err instanceof AgentCoreError ? err.code : 'tool_error';
        const message = err instanceof Error ? err.message : String(err);
        result = { error: code, message: ctx.redactor.redactText(message).slice(0, 1000) };
      }
      messages.push({
        role: 'tool',
        content: JSON.stringify(result),
        tool_call_id: call.id,
      });

      if (isFinishResult(result)) {
        return {
          summary: result.summary,
          stepsTaken,
          tokensUsed: budgets.snapshot().usedTokens,
          finished: true,
        };
      }
    }
  }

  throw new AgentCoreError(
    AgentCoreErrorCode.ITERATION_BUDGET_EXHAUSTED,
    `Agent turn exceeded maxRounds=${maxRounds} without finishRun.`,
    StopCode.ITERATION_BUDGET_EXHAUSTED,
    { maxRounds, stepsTaken },
  );
}

export async function runDirectorTurn(
  opts: DirectorTurnOptions,
): Promise<DirectorTurnResult> {
  // Phase 3 behavior, unchanged: director prompt + full registry.
  // (The Phase 4 orchestrator uses ROLE_DEFS.director.systemPrompt instead.)
  return runAgentTurn({
    ...opts,
    systemPrompt: DIRECTOR_SYSTEM_PROMPT,
    toolDefs: TOOLS,
    modelRole: 'director',
    requiresTools: true,
    // Director is a planning/reasoning role: prefer the most capable model.
    preferLargeModel: true,
    objective: opts.userRequest,
  });
}

/**
 * Run a single role-agent turn (Phase 4): role prompt + restricted tools +
 * capability-based model selection. Used by the orchestrator's dispatcher.
 */
export async function runRoleTurn(
  opts: Omit<AgentTurnOptions, 'systemPrompt' | 'toolDefs' | 'modelRole' | 'requiresTools' | 'objective'> & {
    role: AgentRole;
    objective: string;
  },
): Promise<DirectorTurnResult> {
  const def = getRoleDef(opts.role);
  return runAgentTurn({
    ...opts,
    systemPrompt: def.systemPrompt,
    toolDefs: toolDefsForRole(opts.role),
    modelRole: def.modelRole,
    requiresTools: def.requiresTools,
    objective: opts.objective,
  });
}

const DEFAULT_MAX_ROUNDS = 30;

/* ------------------------------------------------------------------ */
/* Single-shot director (no tool calling)                              */
/* ------------------------------------------------------------------ */

/**
 * Single-shot mode: the model generates the COMPLETE game in ONE response
 * as structured JSON, without calling tools. This bypasses unreliable
 * tool-calling in smaller Cloudflare models.
 *
 * The model outputs: {"files": {"path/to/file": "content", ...}}
 * We parse, validate, and write the files deterministically.
 */

export interface SingleShotOptions {
  runId: string;
  userRequest: string;
  provider: CloudflareClient | AlibabaClient;
  registry: ModelRegistry;
  budgets: BudgetTracker;
  ctx: ToolContext;
  shouldAbort?: () => boolean;
}

export interface SingleShotResult {
  files: Record<string, string>;
  summary: string;
  tokensUsed: number;
}

const SINGLE_SHOT_SYSTEM_PROMPT = `You are an expert game developer. Generate a COMPLETE, PLAYABLE browser game based on the user's request.

OUTPUT FORMAT (strict):
- Output ONLY valid JSON. No explanations, no markdown, no code fences.
- Structure: {"files": {"path": "content", ...}}
- Required files: "index.html" (entry point), plus any JS/CSS/assets.
- All paths are relative. Use "index.html", "src/main.js", "src/style.css", etc.
- The game MUST be playable: include game loop, controls, and win/lose or scoring.
- Keep it focused: a complete small game beats an incomplete large one.

Example:
{"files": {"index.html": "<!DOCTYPE html>...", "src/main.js": "console.log('hi');"}}`;

function extractJson(text: string): Record<string, unknown> {
  // Try direct parse first.
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Try extracting from markdown code block.
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim()) as Record<string, unknown>;
      } catch {
        // Fall through to error.
      }
    }
    throw new AgentCoreError(
      AgentCoreErrorCode.INVALID_RESPONSE,
      'Single-shot director did not return valid JSON.',
      StopCode.INVALID_RESPONSE,
    );
  }
}

export async function runSingleShotDirector(
  opts: SingleShotOptions,
): Promise<SingleShotResult> {
  // Model selection: use Alibaba when configured (Jon has free quota),
  // otherwise use Cloudflare registry.
  let model: string;
  if (process.env['ALIBABA_API_KEY']) {
    // Alibaba models (from Jon's free quota): deepseek-v4-flash is enabled.
    model = 'deepseek-v4-flash-0731';
  } else {
    model = opts.registry.selectModel({
      role: 'director',
      requiresTools: true,
      preferLarge: false,
    });
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SINGLE_SHOT_SYSTEM_PROMPT },
    { role: 'user', content: opts.userRequest },
  ];

  const res = await opts.provider.chatCompletions({
    model,
    messages,
    maxTokens: 8000,
    temperature: 0.7,
  });

  const costUsd = computeCost(model, res.usage.inputTokens, res.usage.outputTokens);
  opts.budgets.recordUsage({
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    costUsd,
  });

  if (!res.content || typeof res.content !== 'string') {
    throw new AgentCoreError(
      AgentCoreErrorCode.INVALID_RESPONSE,
      'Single-shot director returned empty response.',
      StopCode.INVALID_RESPONSE,
    );
  }

  const parsed = extractJson(res.content);
  const files = parsed['files'] as Record<string, string> | undefined;

  if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
    throw new AgentCoreError(
      AgentCoreErrorCode.INVALID_RESPONSE,
      'Single-shot director JSON missing "files" object.',
      StopCode.INVALID_RESPONSE,
    );
  }

  // Validate: all keys are strings, all values are strings.
  for (const [path, content] of Object.entries(files)) {
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw new AgentCoreError(
        AgentCoreErrorCode.INVALID_RESPONSE,
        `Invalid file entry: path and content must be strings (got ${typeof path}/${typeof content}).`,
        StopCode.INVALID_RESPONSE,
      );
    }
    if (path.includes('..') || path.startsWith('/')) {
      throw new AgentCoreError(
        AgentCoreErrorCode.INVALID_RESPONSE,
        `Invalid file path (must be relative, no ..): ${path}`,
        StopCode.INVALID_RESPONSE,
      );
    }
  }

  return {
    files,
    summary: `Generated ${Object.keys(files).length} files in single-shot mode.`,
    tokensUsed: opts.budgets.snapshot().usedTokens,
  };
}

