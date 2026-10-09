import {
  PLUGIN_API_VERSION,
  checkManifestCoherence,
  fullToolName,
  parseManifest,
  type PluginCallerRole,
  type PluginManifest,
  type ToolSpec,
} from './manifest.js';

/**
 * Host-side plugin registry — Phase 6.
 *
 * The registry holds validated manifests and answers two questions:
 *   - which tools exist (namespaced `<plugin>__<tool>`),
 *   - which agent roles may call each tool (from the manifest's `roles`).
 *
 * Registration is a pure validation step; enabling/disabling is the API's
 * job (persisted in the `plugins` table). Agents never touch this class.
 */

export interface RegisteredTool {
  pluginId: string;
  pluginVersion: string;
  /** Host-visible name, e.g. `procedural-geometry__generate`. */
  fullName: string;
  spec: ToolSpec;
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  tools: RegisteredTool[];
}

export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();

  /** Validate and register a manifest. Throws on any problem; atomic (no half state). */
  register(rawManifest: unknown): RegisteredPlugin {
    const manifest = parseManifest(rawManifest);
    checkManifestCoherence(manifest);
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      throw new Error(`Unsupported plugin apiVersion "${manifest.apiVersion}"`);
    }
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin "${manifest.id}" is already registered`);
    }
    const tools: RegisteredTool[] = manifest.tools.map((spec) => ({
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      fullName: fullToolName(manifest.id, spec.name),
      spec,
    }));
    const registered: RegisteredPlugin = { manifest, tools };
    this.plugins.set(manifest.id, registered);
    return registered;
  }

  unregister(pluginId: string): boolean {
    return this.plugins.delete(pluginId);
  }

  get(pluginId: string): RegisteredPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  ids(): string[] {
    return [...this.plugins.keys()];
  }

  /** All registered tools across every plugin (registry order). */
  allTools(): RegisteredTool[] {
    return [...this.plugins.values()].flatMap((p) => p.tools);
  }

  /** Tools a given agent role is allowed to call. Unknown roles get nothing. */
  toolsForRole(role: string): RegisteredTool[] {
    return this.allTools().filter((t) =>
      (t.spec.roles as readonly string[]).includes(role),
    );
  }

  /** Full names a given role may call — the shape agent-core merges into role toolsets. */
  toolNamesForRole(role: PluginCallerRole): string[] {
    return this.toolsForRole(role).map((t) => t.fullName);
  }

  getTool(fullName: string): RegisteredTool | undefined {
    return this.allTools().find((t) => t.fullName === fullName);
  }
}
