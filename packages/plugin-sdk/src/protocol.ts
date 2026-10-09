import { z } from 'zod';
import { TOOL_FULL_NAME_PATTERN } from './manifest.js';

/**
 * Backend tool protocol — Phase 6.
 *
 * Plugin backends run in containers (ARCHITECTURE.md §plugin-sdk) and speak
 * JSON over HTTP. The host POSTs a ToolCallEnvelope; the backend answers with
 * a ToolResultEnvelope. Execution is request/response — never a shell string.
 *
 * Containerized execution is a Phase 7 live step; this module defines the
 * protocol and validates envelopes on both sides. Until then, hosts must
 * refuse plugin tool execution with `plugin_backend_not_configured` rather
 * than faking results.
 */

export const toolCallEnvelopeSchema = z.object({
  /** Host-visible tool name, `<plugin>__<tool>`. */
  tool: z.string().regex(TOOL_FULL_NAME_PATTERN),
  /** Stable per-call id for log correlation (client-generated). */
  callId: z.string().min(1).max(128),
  /** Tool input object, validated by the plugin against its inputSchema. */
  input: z.record(z.string(), z.unknown()),
  context: z.object({
    projectId: z.string().optional(),
    runId: z.string().optional(),
    taskId: z.string().optional(),
    /** Agent role on whose behalf the call is made — for audit only. */
    role: z.string().min(1).max(32),
  }),
});
export type ToolCallEnvelope = z.infer<typeof toolCallEnvelopeSchema>;

export const toolResultEnvelopeSchema = z.object({
  callId: z.string().min(1).max(128),
  ok: z.boolean(),
  /** Present when ok=true. Arbitrary JSON, size-capped by the host. */
  output: z.unknown().optional(),
  /** Present when ok=false. */
  error: z
    .object({
      code: z.string().min(1).max(64),
      message: z.string().min(1).max(2000),
    })
    .optional(),
});
export type ToolResultEnvelope = z.infer<typeof toolResultEnvelopeSchema>;

/** Validate an outgoing call envelope. Throws on malformed input. */
export function makeToolCall(
  tool: string,
  callId: string,
  input: Record<string, unknown>,
  context: ToolCallEnvelope['context'],
): ToolCallEnvelope {
  return toolCallEnvelopeSchema.parse({ tool, callId, input, context });
}

/** Validate an incoming result envelope. Throws on malformed responses. */
export function parseToolResult(raw: unknown): ToolResultEnvelope {
  const result = toolResultEnvelopeSchema.parse(raw);
  if (result.ok && result.error) {
    throw new Error('Malformed tool result: ok=true with an error payload');
  }
  if (!result.ok && !result.error) {
    throw new Error('Malformed tool result: ok=false without an error payload');
  }
  return result;
}

/** Host-side refusal when no container backend is configured. Never fake output. */
export function backendNotConfigured(callId: string): ToolResultEnvelope {
  return {
    callId,
    ok: false,
    error: {
      code: 'plugin_backend_not_configured',
      message:
        'Plugin backend execution is not configured on this host (containerized execution lands in Phase 7).',
    },
  };
}
