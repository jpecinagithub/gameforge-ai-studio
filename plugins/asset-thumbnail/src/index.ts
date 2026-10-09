import { z } from 'zod';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  parseToolResult,
  type ToolCallEnvelope,
  type ToolResultEnvelope,
} from '@gameforge/plugin-sdk';
import { decodePng, downscale, encodePng, PngError } from './png.js';

/**
 * Tool handler for `asset-thumbnail__thumbnail`.
 *
 * Reads a real stored asset (`<storageRoot>/assets/<projectId>/<storedName>`),
 * decodes the PNG, downscales it to fit 128px, and writes the thumbnail to
 * `<storageRoot>/thumbs/<projectId>/<storedName>.png`.
 *
 * Non-PNG or unsupported PNG files return a typed `unsupported_format` error —
 * never a fake thumbnail. All paths are containment-checked.
 */

export const THUMB_MAX_DIM = 128;

const inputSchema = z.object({
  storageRoot: z.string().min(1).max(1024),
  projectId: z.string().min(1).max(128),
  storedName: z.string().min(1).max(256),
});

function contained(root: string, ...parts: string[]): string {
  const resolved = resolve(root, ...parts);
  const rootResolved = resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new PngError('path_escape', 'Path escapes its container');
  }
  return resolved;
}

export async function handleThumbnail(
  envelope: ToolCallEnvelope,
): Promise<ToolResultEnvelope> {
  if (envelope.tool !== 'asset-thumbnail__thumbnail') {
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
  const { storageRoot, projectId, storedName } = parsed.data;
  try {
    // Containment root is the project's asset dir — nothing outside it is readable.
    const assetDir = contained(storageRoot, 'assets', projectId);
    const src = contained(assetDir, storedName);
    const raw = await readFile(src).catch(() => {
      throw new PngError('asset_not_found', `Asset file not found: ${storedName}`);
    });
    if (raw.length > 20 * 1024 * 1024) {
      throw new PngError('too_large', 'Asset exceeds the 20 MiB thumbnail limit');
    }
    const img = decodePng(raw);
    const small = downscale(img, THUMB_MAX_DIM);
    const png = encodePng(small);
    const outDir = contained(storageRoot, 'thumbs', projectId);
    await mkdir(outDir, { recursive: true });
    const outPath = contained(storageRoot, 'thumbs', projectId, `${storedName}.png`);
    await writeFile(outPath, png);
    return parseToolResult({
      callId: envelope.callId,
      ok: true,
      output: {
        thumbnailPath: outPath,
        width: small.width,
        height: small.height,
        sourceWidth: img.width,
        sourceHeight: img.height,
        bytes: png.length,
      },
    });
  } catch (err) {
    const code = err instanceof PngError ? err.code : 'thumbnail_failed';
    const message = err instanceof Error ? err.message : 'Unknown error';
    return parseToolResult({
      callId: envelope.callId,
      ok: false,
      error: {
        // Decode failures are honestly "unsupported format", not "failed".
        code: code === 'not_png' || code.startsWith('unsupported') ? 'unsupported_format' : code,
        message,
      },
    });
  }
}

export { decodePng, downscale, encodePng, PngError } from './png.js';
