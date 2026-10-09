/**
 * @gameforge/plugin-sdk — Phase 6.
 *
 * The plugin contract: manifest validation, host registry, backend tool
 * protocol, sandboxed panel bridge, and the host-owned consent protocol.
 */
export {
  PLUGIN_API_VERSION,
  TOOL_FULL_NAME_PATTERN,
  PLUGIN_ID_PATTERN,
  PLUGIN_CALLER_ROLES,
  PLUGIN_CAPABILITIES,
  toolSpecSchema,
  panelSpecSchema,
  pluginManifestSchema,
  parseManifest,
  fullToolName,
  checkManifestCoherence,
  type PluginCallerRole,
  type PluginCapability,
  type ToolSpec,
  type PanelSpec,
  type PluginManifest,
} from './manifest.js';
export {
  PluginRegistry,
  type RegisteredTool,
  type RegisteredPlugin,
} from './registry.js';
export {
  toolCallEnvelopeSchema,
  toolResultEnvelopeSchema,
  makeToolCall,
  parseToolResult,
  backendNotConfigured,
  type ToolCallEnvelope,
  type ToolResultEnvelope,
} from './protocol.js';
export {
  PLUGIN_PANEL_CSP,
  panelMessageKindSchema,
  panelMessageSchema,
  panelMessage,
  hostMessage,
  parsePanelMessage,
  type PanelMessageKind,
  type PanelMessage,
} from './panels.js';
export {
  consentActorSchema,
  consentDecisionSchema,
  consentCardSchema,
  createConsentCard,
  recordDecision,
  isApproved,
  ConsentError,
  type ConsentActor,
  type ConsentDecision,
  type ConsentCard,
} from './consent.js';
