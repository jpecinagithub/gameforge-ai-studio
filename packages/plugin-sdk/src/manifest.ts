import { z } from 'zod';

/**
 * Plugin manifest schema — Phase 6.
 *
 * Every plugin ships a `plugin.json` validated against this schema before the
 * host accepts it. The manifest is the plugin's ENTIRE contract with the host:
 * nothing outside the declared capabilities, tools, and panels is reachable.
 */

/** Current manifest format version. Hosts reject anything else. */
export const PLUGIN_API_VERSION = 'gameforge-plugin/v1' as const;

/** Tool full-name rule: `<pluginId>__<toolName>`, lowercase segments. */
export const TOOL_FULL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*__[a-z0-9][a-z0-9_-]*$/;

/** Plugin id rule: lowercase slug, also used as the DB primary key. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,62}$/;

/** Agent roles that may call a plugin tool (mirrors agent-core AGENT_ROLES). */
export const PLUGIN_CALLER_ROLES = [
  'director',
  'gameplay',
  'scene_visual',
  'ui',
  'asset',
  'qa',
  'reviewer',
] as const;
export type PluginCallerRole = (typeof PLUGIN_CALLER_ROLES)[number];

/** Capabilities a plugin may declare. Unknown values fail closed. */
export const PLUGIN_CAPABILITIES = [
  'tools', // backend tools callable by designated agent roles
  'panels', // sandboxed UI panels (opaque-origin iframe bridge)
  'assets', // read access to project assets
  'builds', // read access to build evidence (screenshots, verdicts)
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export const toolSpecSchema = z.object({
  /** Short name; the host derives `<pluginId>__<name>` and enforces the rule. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'tool name must be a lowercase slug'),
  description: z.string().min(1).max(500),
  /** JSON-schema-ish description of the tool's input object (documented, host-validated). */
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  /** Which agent roles may call this tool. Empty = none (fail closed). */
  roles: z.array(z.enum(PLUGIN_CALLER_ROLES)).default([]),
  /** Per-call wall-clock budget, ms. Clamped by the host to ≤ 120_000. */
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
});
export type ToolSpec = z.infer<typeof toolSpecSchema>;

export const panelSpecSchema = z.object({
  /** Short name; mounted at /panels/<pluginId>/<name> on a separate origin. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'panel name must be a lowercase slug'),
  title: z.string().min(1).max(120),
  /** Relative path of the panel's entry HTML inside the plugin bundle. */
  entry: z.string().min(1).max(256),
});
export type PanelSpec = z.infer<typeof panelSpecSchema>;

export const pluginManifestSchema = z.object({
  apiVersion: z.literal(PLUGIN_API_VERSION),
  id: z
    .string()
    .min(2)
    .max(64)
    .regex(PLUGIN_ID_PATTERN, 'plugin id must be a lowercase slug'),
  name: z.string().min(1).max(120),
  version: z
    .string()
    .min(1)
    .max(32)
    .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'version must be semver'),
  publisher: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).min(1),
  tools: z.array(toolSpecSchema).default([]),
  panels: z.array(panelSpecSchema).default([]),
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** Parse + validate an untrusted manifest object. Throws on the first problem. */
export function parseManifest(raw: unknown): PluginManifest {
  return pluginManifestSchema.parse(raw);
}

/** Derive the host-visible full tool name. Throws when the result breaks the rule. */
export function fullToolName(pluginId: string, toolName: string): string {
  const full = `${pluginId}__${toolName}`;
  if (!TOOL_FULL_NAME_PATTERN.test(full)) {
    throw new Error(
      `Invalid plugin tool name "${full}": must match <plugin>__<tool> (lowercase slugs)`,
    );
  }
  return full;
}

/** Cross-check manifest coherence: tools ⇒ 'tools' capability, panels ⇒ 'panels'. */
export function checkManifestCoherence(manifest: PluginManifest): void {
  const caps = new Set(manifest.capabilities);
  if (manifest.tools.length > 0 && !caps.has('tools')) {
    throw new Error('Manifest declares tools but lacks the "tools" capability');
  }
  if (manifest.panels.length > 0 && !caps.has('panels')) {
    throw new Error('Manifest declares panels but lacks the "panels" capability');
  }
  const names = new Set<string>();
  for (const t of manifest.tools) {
    if (names.has(t.name)) throw new Error(`Duplicate tool name "${t.name}"`);
    names.add(t.name);
  }
  const panels = new Set<string>();
  for (const p of manifest.panels) {
    if (panels.has(p.name)) throw new Error(`Duplicate panel name "${p.name}"`);
    panels.add(p.name);
  }
}
