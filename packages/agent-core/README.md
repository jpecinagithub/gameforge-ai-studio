# @gameforge/agent-core

Director agent + tool loop for GameForge AI Studio (Phase 3).

## Tool-loop design

`runDirectorTurn()` runs one Groq tool-calling session for up to `maxRounds`
(default 30) rounds:

1. Model selection is capability-gated: `registry.selectModel({ role: 'director',
   requiresTools: true })` — no model names appear in this package.
2. Each round: `groq.chatCompletions({ model, messages, tools })` →
   `budgets.recordUsage(...)` (typed throw on breach) → execute tool calls
   sequentially → append results as `tool` messages.
3. The loop ends when the model calls `finishRun`, stops calling tools, or a
   typed control-flow signal fires.

Every completion's usage is recorded in the `BudgetTracker` (tokens always;
cost via `computeCost`, `null` when the model has no verified price — never
guessed). Budgets are load-bearing: Groq is always metered.

## Checkpoint-before-edit guarantee

`writeFile` implements the F8 rule structurally, in this order:

1. **Optimistic concurrency check** — `expectedCommitSha` vs `git.head()`.
   Mismatch → typed `CONFLICT`, no checkpoint, file untouched.
2. **Git checkpoint** — `git.checkpoint("before agent edit <path>")` commits the
   pre-edit worktree. Clean tree → returns HEAD, no empty commit.
3. **Write** — only then is the file written.

There is no code path that writes without checkpointing first. The unit test
proves the ordering behaviorally (the checkpoint observes the target absent).

## PauseForUser control flow

`askUser` is not an error — it is typed control flow:

```
askUser tool → events.questionAsked(...) → throw new PauseForUser(questionId)
    → runDirectorTurn rethrows untouched
    → runAgentJob propagates
    → worker maps to run status `waiting_for_user`
```

Callers check `isPauseForUser(err)` — never match message text. When the user
answers, the worker resumes the run and the answer is injected into the
director's next turn.

## What runAgentJob expects from the worker

`runAgentJob({ runId, projectId, db, queues, workDir, userRequest, groq, registry, … })`
is called by `apps/worker` **after** it has claimed the run
(`queued → planning`, atomic). The worker keeps: claim, pause/resume/cancel
checks, and `interrupted`-marking on unexpected throws.

`runAgentJob` owns, in order:

1. `ensureGitRepo(workDir)` — init + local agent identity if missing.
2. `loadConversationContext(db, projectId)` — last 20 user/assistant messages
   as lightweight project memory for the director.
3. `runDirectorTurn(...)` — the tool loop. `PauseForUser`,
   `BudgetExhaustedError` and `AgentCoreError` propagate typed.
4. Final build pass via the `execBuild` tool + bounded poll of `buildStatus`,
   so a run never ends without a build verdict even if the director never built.
5. `evidence.gather(buildId)` on `verified`/`partial` builds.
6. Returns `{ summary, buildId, buildStatus, evidence, stepsTaken, tokensUsed }` —
   the worker persists the summary and marks the run `completed`.

`DbLike` needs only `query()`; `QueuesLike` needs `enqueueBuild()` /
`getBuildStatus()`. `EvidenceProvider` is a local interface — agent-core never
imports playwright; the real implementation lives in `@gameforge/test-runner`.

## Typed errors

`AgentCoreError { code, stopCode, detail }` — `code` is one of
`unknown_tool | tool_validation_failed | tool_execution_failed | conflict |
iteration_budget_exhausted | aborted | git_failed`; `stopCode` maps to the
orchestration-level `StopCode` for run finalization. `toStopCode(err)` extracts it.

## Prompts are versioned data

`DIRECTOR_SYSTEM_PROMPT` carries a `PROMPT v1 — 2026-10-09` version tag.
Improvements go through the `skill_versions` table (candidate → held-out gate →
active/rolled_back); this file only ever carries the ACTIVE version.

## Scope note (Phase 4)

The director is deliberately single-role in Phase 3. The multi-agent roles
(gameplay, scene_visual, ui, asset, qa, reviewer) with per-role prompts, models,
tool permissions and budgets land in Phase 4 — the `AgentRole` enum and the
`ToolContext` seams are already shaped for them.

## Phase 4 — multi-agent orchestration

`runMultiAgentJob(opts)` extends `runAgentJob` without changing its signature;
the worker chooses which to call.

### Roles (`src/roles.ts`)

Seven roles, each with a version-tagged prompt, a restricted tool subset, and a
capability-based model-selection key (never a model name):

| role | tools | model key |
|---|---|---|
| director | all 10 (incl. dispatchTask, remember, askUser) | director |
| gameplay | read/write/list, build, status, evidence, finish | codegen |
| scene_visual | read/write/list, build, status, evidence, finish | codegen |
| ui | read/write/list, build, status, evidence, finish | codegen |
| asset | read/write/list, finish (no builds) | codegen |
| qa | read-only + evidence (no writes) | reasoning |
| reviewer | read-only + evidence (no write/execBuild/askUser) | review |

`toolDefsForRole(role)` filters the registry; `executeToolCallWith` enforces it —
an out-of-scope call fails closed with `unknown_tool` (behaviorally tested).

### Task DAG (`src/tasks.ts`)

Task IDs are deterministic: `task_<sha1(runId|role|objective)[0..12]>`, so
retries and replays converge instead of duplicating work. `topologicalOrder()`
validates dependency graphs; cycles throw typed `CYCLIC_DEPENDENCY`.
`TaskStore` is an interface (pg implementation in the worker); a memory
implementation ships for tests.

### Worktrees (`src/worktrees.ts`)

Each dispatched task (except reviewer/qa, which read the main tree) runs in an
isolated worktree at `<repo>/.studio/worktrees/<taskId>` on branch
`studio/runs/<runId>/<taskId>`. On success the orchestrator checkpoints the
main tree, then merges with `--no-ff`. Conflicts throw typed `MERGE_CONFLICT`
with the conflicting paths — never auto-resolved, never silently overwritten.
The worktree checkout is discarded after merge; the branch is kept recoverable.

### Blind review (`src/review.ts`)

`blindReview()` judges two build candidates with a FRESH context (evidence
summaries + criteria only — no history). Structural blindness: the incumbent
label is never sent to the reviewer. Returns `{ pick, biggestGap }` — never
numeric scores. A garbled verdict KEEPS THE INCUMBENT (`keptIncumbent: true`);
retries are bounded (default 2).

### Orchestrator (`src/orchestrator.ts`)

1. Director turn (director role prompt) with `dispatchTask`; the dispatcher runs
   each role agent synchronously in-process in its worktree and merges on success.
2. Manual mode: `askUser` approval gate before building (`PauseForUser`
   propagates to the worker).
3. Verify cycle: `execBuild` → poll → `gatherEvidence` → `blindReview` vs the
   incumbent (last-good) build.
4. Bounded correction (max 3): reviewer's `biggestGap` → gameplay fix task →
   rebuild → re-review; stops early on no measurable progress
   (`NO_MEASURABLE_PROGRESS`).
5. Loop mode: improvement turns while budgets remain AND progress is measurable
   (verdict rank up, or review flipped to the candidate).

**Why dispatch is synchronous in Phase 4:** in-process dispatch keeps the
failure semantics simple (typed propagation, one journal) while the
orchestration design stabilizes. The `TaskStore` rows, deterministic task IDs,
and `dependsOn` DAG are exactly the seams BullMQ fan-out needs — moving
dispatch to the `agent-tasks` queue in Phase 7 requires no prompt or contract
changes.
