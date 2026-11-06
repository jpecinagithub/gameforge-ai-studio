/**
 * Top Tools AI gateway (OpenAI-compatible API).
 *
 * Top Tools AI aggregates third-party models behind one OpenAI-compatible
 * endpoint:
 *   https://top-tools-ai.com/api/v1/chat/completions
 *
 * Auth: Bearer <apiKey> (server env TOP_TOOLS_API_KEY). The key is issued in
 * the Top Tools AI dashboard (API keys) and draws on the account's welcome
 * tokens for non-PAYG models, except the house model Top-Tools-Ai.
 *
 * The gateway speaks the same chat completions shape as OpenRouter, so the
 * OpenRouterClient drives it with a different baseUrl. Only the model ids
 * differ (for example Kimi-K2.7-Code instead of openai/gpt-5.6-luna).
 *
 * Default agent model: Kimi-K2.7-Code, the code variant of the Kimi K2
 * family. Tool calling was verified live against it on 2026-11-06
 * (tool called with correct arguments, final answer after the tool result).
 * Kimi-K2.6 is the general sibling and behaves the same way.
 */

/** Base URL for every Top Tools AI API call. */
export const TOP_TOOLS_BASE_URL = 'https://top-tools-ai.com/api/v1';

/** Agent model used when TOP_TOOLS_AGENT_MODEL is not set. */
export const TOP_TOOLS_DEFAULT_AGENT_MODEL = 'Kimi-K2.7-Code';

/** Context window (tokens) for the Kimi K2 family. */
export const TOP_TOOLS_KIMI_CONTEXT_WINDOW = 256_000;

/**
 * The configured Top Tools AI key, or null when absent or blank.
 * Never log the returned value.
 */
export function topToolsApiKey(): string | null {
  const key = process.env['TOP_TOOLS_API_KEY'];
  return key && key.trim().length > 0 ? key : null;
}

/** True when a Top Tools AI key is configured. */
export function isTopToolsConfigured(): boolean {
  return topToolsApiKey() !== null;
}

/** Agent model for Top Tools AI: TOP_TOOLS_AGENT_MODEL or the default. */
export function topToolsAgentModel(): string {
  return process.env['TOP_TOOLS_AGENT_MODEL']?.trim() || TOP_TOOLS_DEFAULT_AGENT_MODEL;
}
