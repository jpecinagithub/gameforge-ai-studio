import { z } from 'zod';

/**
 * Sandboxed panel bridge — Phase 6.
 *
 * Plugin UI panels run in an opaque-origin iframe and talk to the host page
 * exclusively through `postMessage` with these typed envelopes. The iframe
 * gets NO host API surface beyond this protocol: no direct fetch to the API,
 * no localStorage access to studio keys, no parent-frame DOM access.
 *
 * Hosting requirements (enforced by the frontend that mounts panels):
 *   - iframe `sandbox="allow-scripts"` (no allow-same-origin, no allow-top-navigation)
 *   - Content-Security-Policy: PLUGIN_PANEL_CSP
 *   - host validates `event.origin` against the panel's registered origin
 */

export const PLUGIN_PANEL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Message kinds. `panel:*` flow panel → host; `host:*` flow host → panel. */
export const panelMessageKindSchema = z.enum([
  'panel:ready', // panel loaded and listening
  'panel:resize', // panel requests a height change { height }
  'panel:event', // panel → host telemetry/action request { name, data }
  'host:init', // host → panel on mount { pluginId, panel, theme, locale, context }
  'host:theme', // host → panel theme change { theme }
  'host:error', // host → panel fatal notice { message }
]);
export type PanelMessageKind = z.infer<typeof panelMessageKindSchema>;

export const panelMessageSchema = z.object({
  /** Protocol marker so hosts can ignore foreign postMessage traffic. */
  protocol: z.literal('gameforge-plugin-panel/v1'),
  kind: panelMessageKindSchema,
  pluginId: z.string().min(1).max(64),
  panel: z.string().min(1).max(64),
  /** Sequence number per sender, for ordering. */
  seq: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type PanelMessage = z.infer<typeof panelMessageSchema>;

/** Build a panel→host message. Rejects host: kinds at runtime. */
export function panelMessage(
  kind: Extract<PanelMessageKind, `panel:${string}`>,
  pluginId: string,
  panel: string,
  seq: number,
  payload: Record<string, unknown> = {},
): PanelMessage {
  if (!kind.startsWith('panel:')) {
    throw new Error(`panelMessage cannot build kind "${kind}"`);
  }
  return panelMessageSchema.parse({ protocol: 'gameforge-plugin-panel/v1', kind, pluginId, panel, seq, payload });
}

/** Build a host→panel message. Rejects panel: kinds at runtime. */
export function hostMessage(
  kind: Extract<PanelMessageKind, `host:${string}`>,
  pluginId: string,
  panel: string,
  seq: number,
  payload: Record<string, unknown> = {},
): PanelMessage {
  if (!kind.startsWith('host:')) {
    throw new Error(`hostMessage cannot build kind "${kind}"`);
  }
  return panelMessageSchema.parse({ protocol: 'gameforge-plugin-panel/v1', kind, pluginId, panel, seq, payload });
}

/** Validate an inbound postMessage payload. Returns null instead of throwing. */
export function parsePanelMessage(raw: unknown): PanelMessage | null {
  const parsed = panelMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
