import { z } from 'zod';
import {
  AgentRole,
  AssetGenerationStatus,
  AssetProvider,
  BuildStatus,
  ExecutionMode,
  GameKind,
  ImprovementScope,
  ImprovementStatus,
  ReviewResultValue,
  RunStatus,
  StopCode,
  TaskStatus,
} from './enums.js';

/** Path validation shared by every file-touching route (§25: traversal defense). */
export const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !p.startsWith('/') && !p.includes('\\'), 'must be relative')
  .refine((p) => !/(^|\/)\.\.(\/|$)/.test(p), 'no parent traversal')
  .refine((p) => !p.startsWith('.'), 'no dotfiles');

const zodEnum = <T extends Record<string, string>>(o: T) =>
  z.enum(Object.values(o) as [string, ...string[]]);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/* ---------- Projects ---------- */

export const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  template: z.string().min(1).max(64),
  kind: zodEnum(GameKind).optional(),
  engine: z.enum(['three', 'phaser', 'pixi', 'canvas2d']).default('three'),
});

export const patchProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

/* ---------- Conversations / messages ---------- */

export const postMessageSchema = z.object({
  role: z.enum(['user']),
  content: z.string().min(1).max(20000),
  // Optional: start/attach to a run in a given mode.
  startRun: z
    .object({
      mode: zodEnum(ExecutionMode),
      idempotencyKey: z.string().min(8).max(128).optional(),
    })
    .optional(),
});

/* ---------- Runs ---------- */

export const createRunSchema = z.object({
  mode: zodEnum(ExecutionMode),
  conversationId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
  budgets: z
    .object({
      maxIterations: z.number().int().min(1).max(200).optional(),
      maxWallclockMs: z.number().int().min(60000).max(86400000).optional(),
      maxTokens: z.number().int().min(1000).optional(),
      maxCostUsd: z.number().min(0).optional(),
    })
    .optional(),
});

export const runStatusSchema = zodEnum(RunStatus);
export const stopCodeSchema = zodEnum(StopCode);
export const taskStatusSchema = zodEnum(TaskStatus);
export const agentRoleSchema = zodEnum(AgentRole);
export const buildStatusSchema = zodEnum(BuildStatus);

/* ---------- Builds ---------- */

export const createBuildSchema = z.object({
  idempotencyKey: z.string().min(8).max(128).optional(),
});

/* ---------- Assets ---------- */

export const assetProviderSchema = zodEnum(AssetProvider);
export const assetGenerationStatusSchema = zodEnum(AssetGenerationStatus);

export const createAssetGenerationSchema = z.object({
  provider: assetProviderSchema,
  kind: z.enum([
    'model',
    'image',
    'texture',
    'audio',
    'music',
    'video',
    'material',
  ]),
  prompt: z.string().min(1).max(1024),
  params: z.record(z.string(), z.unknown()).optional(),
});

/* ---------- Review ---------- */

export const reviewResultSchema = zodEnum(ReviewResultValue);

/* ---------- Settings ---------- */

export const patchSettingsSchema = z.object({
  defaultMode: zodEnum(ExecutionMode).optional(),
  maxParallelAgents: z.number().int().min(1).max(8).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  maxRunMinutes: z.number().int().min(5).max(1440).optional(),
  aiBudgetUsd: z.number().min(0).optional(),
  assetStorageMb: z.number().int().min(100).optional(),
  previewQuality: z.enum(['low', 'medium', 'high']).optional(),
  language: z.enum(['en', 'es']).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  sound: z.boolean().optional(),
  confirmations: z.boolean().optional(),
  modelByRole: z.record(z.string(), z.string()).optional(),
});

/* ---------- Models ---------- */

export const modelCapabilitiesSchema = z.object({
  context_window: z.number().int().positive(),
  supports_tools: z.boolean(),
  supports_vision: z.boolean(),
  supports_json_mode: z.boolean(),
  max_output_tokens: z.number().int().positive().optional(),
});

/* ---------- Self-improvement (§6) ---------- */

/** Evidence refs must name REAL records; the API validates each one at propose time. */
export const improvementEvidenceSchema = z.object({
  kind: z.enum(['build', 'review']),
  id: z.string().min(1).max(64),
});

export const proposeImprovementSchema = z.object({
  title: z.string().min(1).max(200),
  scope: zodEnum(ImprovementScope),
  /** prompt name | settings key | repo-relative file path */
  target: z.string().min(1).max(512),
  /** Scope-bounded change payload (validated per scope by the route). */
  change: z.record(z.string(), z.unknown()),
  evidence: z.array(improvementEvidenceSchema).min(1).max(20),
});

export const activateImprovementSchema = z.object({
  /** Results of the held-out gate that justifies promoting the candidate. */
  gateEvidence: z.array(improvementEvidenceSchema).min(1).max(20),
});

export const improvementStatusSchema = zodEnum(ImprovementStatus);

export type Pagination = z.infer<typeof paginationSchema>;
export type CreateProject = z.infer<typeof createProjectSchema>;
export type CreateRun = z.infer<typeof createRunSchema>;
