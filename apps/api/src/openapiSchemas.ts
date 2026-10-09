/**
 * Hand-written minimal JSON Schemas for OpenAPI, mirroring the zod schemas in
 * @gameforge/shared. Kept in sync by review; the zod schemas remain the runtime
 * source of truth (validation happens in routes, not in Fastify's validator).
 */

const zodEnumValues = (vals: string[]) => ({ type: 'string', enum: vals });

export const ErrorEnvelope = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        detail: { type: 'object', additionalProperties: true },
        requestId: { type: 'string' },
      },
    },
  },
} as const;

export const CreateProjectBody = {
  type: 'object',
  required: ['name', 'template'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 2000 },
    template: {
      type: 'string',
      enum: [
        'three-empty',
        'three-fps',
        'three-third-person',
        'three-racing',
        'three-platformer',
        'arcade-2d',
        'puzzle',
        'physics-sandbox',
      ],
    },
    kind: zodEnumValues([
      'first-person',
      'third-person',
      'top-down',
      'side-2d',
      'racing',
      'flight',
      'static-board',
      'free-camera',
    ]),
    engine: { type: 'string', enum: ['three', 'phaser', 'pixi', 'canvas2d'], default: 'three' },
  },
} as const;

export const ProjectJson = {
  type: 'object',
  required: ['id', 'slug', 'name', 'template', 'engine', 'status'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    slug: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    template: { type: 'string' },
    kind: { type: ['string', 'null'] },
    engine: { type: 'string' },
    status: { type: 'string' },
    currentRevisionId: { type: ['string', 'null'] },
    lastGoodBuildId: { type: ['string', 'null'] },
    metadata: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

export const PatchProjectBody = {
  type: 'object',
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    status: { type: 'string', enum: ['active', 'archived'] },
  },
} as const;

export const CreateRunBody = {
  type: 'object',
  required: ['mode'],
  properties: {
    mode: { type: 'string', enum: ['manual', 'auto', 'loop'] },
    conversationId: { type: 'string', format: 'uuid' },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
    budgets: {
      type: 'object',
      properties: {
        maxIterations: { type: 'integer', minimum: 1, maximum: 200 },
        maxWallclockMs: { type: 'integer', minimum: 60000, maximum: 86400000 },
        maxTokens: { type: 'integer', minimum: 1000 },
        maxCostUsd: { type: 'number', minimum: 0 },
      },
    },
  },
} as const;

export const RunJson = {
  type: 'object',
  required: ['id', 'projectId', 'mode', 'status'],
  properties: {
    id: { type: 'string' },
    projectId: { type: 'string' },
    conversationId: { type: ['string', 'null'] },
    mode: { type: 'string' },
    status: { type: 'string' },
    currentStep: { type: ['string', 'null'] },
    budgets: { type: 'object', additionalProperties: true },
    paused: { type: 'boolean' },
    startedAt: { type: ['string', 'null'] },
    endedAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
  },
} as const;

export const PatchSettingsBody = {
  type: 'object',
  minProperties: 1,
  properties: {
    defaultMode: { type: 'string', enum: ['manual', 'auto', 'loop'] },
    maxParallelAgents: { type: 'integer', minimum: 1, maximum: 8 },
    maxRetries: { type: 'integer', minimum: 0, maximum: 10 },
    maxRunMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
    aiBudgetUsd: { type: 'number', minimum: 0 },
    assetStorageMb: { type: 'integer', minimum: 100 },
    previewQuality: { type: 'string', enum: ['low', 'medium', 'high'] },
    language: { type: 'string', enum: ['en', 'es'] },
    theme: { type: 'string', enum: ['dark', 'light'] },
    sound: { type: 'boolean' },
    confirmations: { type: 'boolean' },
    modelByRole: { type: 'object', additionalProperties: { type: 'string' } },
  },
} as const;

export const PostMessageBody = {
  type: 'object',
  required: ['role', 'content'],
  properties: {
    role: { type: 'string', enum: ['user'] },
    content: { type: 'string', minLength: 1, maxLength: 20000 },
  },
} as const;

export const FileEntryJson = {
  type: 'object',
  required: ['path', 'size', 'modifiedAt'],
  properties: {
    path: { type: 'string' },
    size: { type: 'integer', minimum: 0 },
    modifiedAt: { type: 'string' },
  },
} as const;

export const FileContentJson = {
  type: 'object',
  required: ['path', 'content'],
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
    sha: { type: ['string', 'null'] },
  },
} as const;

export const WriteFileBody = {
  type: 'object',
  required: ['content'],
  properties: {
    content: { type: 'string', maxLength: 2 * 1024 * 1024 },
    expectedSha: { type: 'string', pattern: '^[0-9a-fA-F]{40}$' },
  },
} as const;

export const RevisionJson = {
  type: 'object',
  required: ['id', 'sha', 'message'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    sha: { type: 'string' },
    message: { type: 'string' },
    author: { type: ['string', 'null'] },
    checkpointKind: { type: ['string', 'null'] },
    healthy: { type: 'boolean' },
    createdAt: { type: 'string' },
  },
} as const;

export const AssetJson = {
  type: 'object',
  required: ['id', 'projectId', 'kind'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    path: { type: 'string' },
    kind: { type: 'string' },
    format: { type: 'string' },
    bytes: { type: 'integer', minimum: 0 },
    contentHash: { type: 'string' },
    source: { type: 'string' },
    useStage: { type: 'string' },
    url: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;

export const TestResultJson = {
  type: 'object',
  required: ['name', 'status'],
  properties: {
    suite: { type: ['string', 'null'] },
    name: { type: 'string' },
    status: { type: 'string', enum: ['pass', 'fail', 'skip', 'error'] },
    durationMs: { type: ['integer', 'null'] },
    details: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string' },
  },
} as const;

export const ReviewResultJson = {
  type: 'object',
  required: ['criterion', 'result'],
  properties: {
    criterion: { type: 'string' },
    result: { type: 'string', enum: ['pass', 'fail', 'unverified'] },
    confidence: { type: ['number', 'null'] },
    evidence: { type: 'object', additionalProperties: true },
    issue: { type: ['string', 'null'] },
    recommendation: { type: ['string', 'null'] },
    retestRequired: { type: 'boolean' },
    judgeModel: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
  },
} as const;

export const BuildArtifactJson = {
  type: 'object',
  required: ['id', 'kind', 'name'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    kind: { type: 'string' },
    name: { type: 'string' },
    size: { type: ['integer', 'null'] },
    url: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;
