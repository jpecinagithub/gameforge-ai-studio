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
  provider: CloudflareClient;
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
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(opts.history ?? []),
    { role: 'user', content: objective },
  ];

  let stepsTaken = 0;

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
      return {
        summary: res.content ?? '',
        stepsTaken,
        tokensUsed: budgets.snapshot().usedTokens,
        finished: false,
      };
    }

    // Echo the assistant's tool calls back (OpenAI wire format needs them).
    messages.push({
      role: 'assistant',
      content: res.content,
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

