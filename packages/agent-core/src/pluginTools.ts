import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PluginRegistry,
  backendNotConfigured,
  makeToolCall,
  parseToolResult,
  type RegisteredTool,
  type ToolCallEnvelope,
  type ToolResultEnvelope,
} from '@gameforge/plugin-sdk';
import { StopCode } from '@gameforge/shared';
import { AgentCoreError, AgentCoreErrorCode } from './errors.js';
import { getRoleDef, type AgentRole } from './roles.js';
import { toolDefsForRole, type AnyToolDef, type ToolContext } from './tools.js';

/**
 * Plugin tool channel for agent roles — Phase 6.
 *
 * Installed plugins expose tools as `<plugin>__<tool>`. This module turns a
 * PluginRegistry into agent ToolDefs, gated per role:
 *
 *   - REGISTRY GATE: a role only SEEES tools whose manifest `roles` include it
 *     (via toolDefsForRoleWithPlugins). Unknown roles see nothing.
 *   - EXECUTION GATE: execute() re-checks ctx.role against the manifest and
 *     fails closed if the caller role is not listed — even if the def leaked.
 *
 * Plugin INSTALL/ENABLE/DISABLE are deliberately NOT tools here: no agent
 * role may ever install or enable plugins (trust model, ARCHITECTURE.md).
 * Those are host-only HTTP endpoints guarded by the agent-identity check.
 */

/** Executes one plugin tool call envelope. Injected by the host. */
export type PluginExecutor = (
  envelope: ToolCallEnvelope,
) => Promise<ToolResultEnvelope>;

/** Handler signature for the local (in-process) dev executor. */
export type LocalPluginHandler = (
  envelope: ToolCallEnvelope,
) => Promise<ToolResultEnvelope> | ToolResultEnvelope;

/**
 * Local in-process executor — DEVELOPMENT AND TESTS ONLY.
 *
 * Production runs plugin backends in containers and must inject a real
 * executor that POSTs envelopes to them. This helper is explicitly labeled
 * so nobody mistakes in-process execution for the production posture.
 */
export function createLocalPluginExecutor(
  handlers: Record<string, LocalPluginHandler>,
): PluginExecutor {
  return async (envelope) => {
    const handler = handlers[envelope.tool];
    if (!handler) {
      return parseToolResult({
        callId: envelope.callId,
        ok: false,
        error: {
          code: 'unknown_tool',
          message: `No local handler registered for "${envelope.tool}"`,
        },
      });
    }
    return handler(envelope);
  };
}

/** Fail-closed executor: refuses instead of faking plugin output. */
export function refusingPluginExecutor(): PluginExecutor {
  return async (envelope) => backendNotConfigured(envelope.callId);
}

function pluginToolDef(tool: RegisteredTool, executor: PluginExecutor): AnyToolDef {
  return {
    name: tool.fullName,
    description: `[plugin ${tool.pluginId}@${tool.pluginVersion}] ${tool.spec.description}`,
    schema: z.record(z.string(), z.unknown()),
    parameters: {
      type: 'object',
      description: `[plugin ${tool.pluginId}] ${tool.spec.description}`,
    },
    execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
      // EXECUTION GATE: the invoking role must be listed in the manifest.
      const role = ctx.role;
      if (!role || !(tool.spec.roles as readonly string[]).includes(role)) {
        throw new AgentCoreError(
          AgentCoreErrorCode.TOOL_EXECUTION_FAILED,
          `Role "${role ?? 'unknown'}" may not call plugin tool "${tool.fullName}"`,
          StopCode.TOOL_PERMISSION_DENIED,
          { tool: tool.fullName, role: role ?? null },
        );
      }
      const envelope = makeToolCall(
        tool.fullName,
        randomUUID(),
        (args ?? {}) as Record<string, unknown>,
        {
          projectId: ctx.projectId,
          runId: ctx.runId,
          role,
        },
      );
      let result: ToolResultEnvelope;
      try {
        result = await executor(envelope);
      } catch (err) {
        throw new AgentCoreError(
          AgentCoreErrorCode.TOOL_EXECUTION_FAILED,
          `Plugin tool "${tool.fullName}" executor threw: ${err instanceof Error ? err.message : 'unknown'}`,
          StopCode.UNKNOWN,
          { tool: tool.fullName },
        );
      }
      const parsed = parseToolResult(result);
      if (!parsed.ok) {
        throw new AgentCoreError(
          AgentCoreErrorCode.TOOL_EXECUTION_FAILED,
          `Plugin tool "${tool.fullName}" failed: ${parsed.error?.message ?? 'unknown'}`,
          StopCode.UNKNOWN,
          { tool: tool.fullName, code: parsed.error?.code },
        );
      }
      return parsed.output;
    },
  };
}

/**
 * All registered plugin tools as agent ToolDefs (unfiltered).
 * Prefer toolDefsForRoleWithPlugins, which applies the role gate.
 */
export function allPluginToolDefs(
  registry: PluginRegistry,
  executor: PluginExecutor,
): AnyToolDef[] {
  return registry.allTools().map((t) => pluginToolDef(t, executor));
}

/**
 * Tool definitions for a role: core tools + the plugin tools whose manifest
 * lists this role. Unknown roles fail closed via getRoleDef.
 */
export function toolDefsForRoleWithPlugins(
  role: AgentRole,
  registry: PluginRegistry,
  executor: PluginExecutor,
): AnyToolDef[] {
  getRoleDef(role); // fail closed on unknown roles
  const allowed = new Set(registry.toolNamesForRole(role));
  return allPluginToolDefs(registry, executor).filter((d) => allowed.has(d.name));
}

/**
 * Full def set for a role: core defs first (registry order), then plugin defs.
 * This is what runRoleTurn should receive once hosts wire plugin execution.
 */
export function mergedToolDefsForRole(
  role: AgentRole,
  registry: PluginRegistry,
  executor: PluginExecutor,
): AnyToolDef[] {
  return [...toolDefsForRole(role), ...toolDefsForRoleWithPlugins(role, registry, executor)];
}
