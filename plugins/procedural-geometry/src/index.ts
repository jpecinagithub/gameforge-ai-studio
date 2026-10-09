import { z } from 'zod';
import {
  parseToolResult,
  type ToolCallEnvelope,
  type ToolResultEnvelope,
} from '@gameforge/plugin-sdk';
import { generateMesh, type GenerateOptions, type PrimitiveKind } from './geometry.js';

/**
 * Tool handler for `procedural-geometry__generate`.
 *
 * This is the plugin's backend entry point: the host POSTs a ToolCallEnvelope
 * (JSON over HTTP) and the container runs this handler, returning a
 * ToolResultEnvelope. No shell, no side effects — pure computation.
 */
const inputSchema = z.object({
  kind: z.enum(['box', 'sphere', 'plane', 'terrain']),
  seed: z.number().int(),
  size: z.number().positive().max(10_000).optional(),
  detail: z.number().int().min(1).max(64).optional(),
});

export function handleGenerate(envelope: ToolCallEnvelope): ToolResultEnvelope {
  if (envelope.tool !== 'procedural-geometry__generate') {
    return parseToolResult({
      callId: envelope.callId,
      ok: false,
      error: { code: 'unknown_tool', message: `Unknown tool "${envelope.tool}"` },
    });
  }
  const parsed = inputSchema.safeParse(envelope.input);
  if (!parsed.success) {
    return parseToolResult({
      callId: envelope.callId,
      ok: false,
      error: { code: 'invalid_input', message: 'Input failed validation' },
    });
  }
  const opts: GenerateOptions = {
    kind: parsed.data.kind as PrimitiveKind,
    seed: parsed.data.seed,
    size: parsed.data.size,
    detail: parsed.data.detail,
  };
  try {
    const mesh = generateMesh(opts);
    return parseToolResult({
      callId: envelope.callId,
      ok: true,
      output: {
        kind: mesh.kind,
        seed: mesh.seed,
        vertexCount: mesh.vertices.length,
        faceCount: mesh.faces.length,
        vertices: mesh.vertices,
        faces: mesh.faces,
      },
    });
  } catch (err) {
    return parseToolResult({
      callId: envelope.callId,
      ok: false,
      error: {
        code: 'generation_failed',
        message: err instanceof Error ? err.message : 'Unknown error',
      },
    });
  }
}

export { generateMesh } from './geometry.js';
export type { Mesh, GenerateOptions, PrimitiveKind } from './geometry.js';
