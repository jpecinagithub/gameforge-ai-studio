# GameForge Plugin Developer Guide

Plugins extend GameForge AI Studio with backend tools and sandboxed UI panels.
This guide documents the plugin contract, the trust model, and how to write
your own plugin. The contract is implemented by `@gameforge/plugin-sdk`
(`packages/plugin-sdk`).

## The contract in one paragraph

A plugin is a directory containing a **`plugin.json` manifest**. The host
validates the manifest against a strict schema, registers the declared tools
under namespaced names (`<plugin-id>__<tool-name>`), and exposes them to the
agent roles the manifest lists. Nothing outside the manifest is reachable.
Plugin backends run in containers and speak JSON over HTTP.

## Manifest (`plugin.json`)

```json
{
  "apiVersion": "gameforge-plugin/v1",
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "publisher": "you",
  "description": "What it does, in one or two sentences.",
  "capabilities": ["tools"],
  "tools": [
    {
      "name": "generate",
      "description": "Generates something.",
      "inputSchema": { "seed": "integer" },
      "roles": ["asset", "scene_visual"],
      "timeoutMs": 10000
    }
  ],
  "panels": []
}
```

Rules the host enforces (fail closed):

- `apiVersion` must be exactly `gameforge-plugin/v1`.
- `id` is a lowercase slug; it becomes the database primary key.
- `version` is semver.
- `capabilities` is a closed set: `tools`, `panels`, `assets`, `builds`.
  Declaring tools without the `tools` capability is rejected; same for panels.
- Tool full names are derived as `<id>__<name>` and must match
  `^[a-z0-9][a-z0-9_-]*__[a-z0-9][a-z0-9_-]*$`.
- `roles` lists which agent roles may call each tool (`director`,
  `gameplay`, `scene_visual`, `ui`, `asset`, `qa`, `reviewer`). An empty
  list means nobody can call it. Unknown roles are rejected.
- `timeoutMs` is clamped to 1s–120s.

Validate locally with `parseManifest()` + `checkManifestCoherence()` from the SDK.

## Backend tool protocol

The host POSTs a JSON envelope to the plugin backend:

```json
{
  "tool": "my-plugin__generate",
  "callId": "…",
  "input": { "seed": 42 },
  "context": { "projectId": "…", "runId": "…", "role": "asset" }
}
```

The backend answers with:

```json
{ "callId": "…", "ok": true, "output": { … } }
```

or, on failure:

```json
{ "callId": "…", "ok": false, "error": { "code": "invalid_input", "message": "…" } }
```

Never return fake output. If your tool cannot handle an input, return a
typed error (e.g. `unsupported_format`) — the asset-thumbnail plugin does
exactly this for non-PNG files.

**Execution model (honest status):** plugin backends are designed to run in
containers with the same isolation as the game runner (ARCHITECTURE.md
§plugin-sdk). Containerized execution lands in Phase 7; until then the host
refuses tool calls with `plugin_backend_not_configured` instead of faking
results. The SDK ships `createLocalPluginExecutor()` for development and
tests only — it is explicitly labeled and must never be mistaken for the
production posture.

## Sandboxed panels

Panels are optional UI surfaces mounted by the frontend:

- Each panel runs in an **opaque-origin iframe** with
  `sandbox="allow-scripts"` and the strict `PLUGIN_PANEL_CSP` (no network,
  no top navigation, no parent-frame access).
- Communication is `postMessage` only, using the typed envelopes in
  `panels.ts` (protocol marker `gameforge-plugin-panel/v1`; `panel:*`
  messages flow panel → host, `host:*` flow host → panel).
- The host validates `event.origin` and drops foreign traffic.

## Trust model — read this before anything else

1. **Agents can never install or enable plugins.** The agent tool registry
   never contains install/enable/disable tools — only `<plugin>__<tool>`
   execution tools for the roles each manifest lists. Additionally, the
   `POST /plugins/install|enable|disable` endpoints reject any request that
   identifies as agent-originated (`x-agent-role` header or
   `actor: "agent:*"` body field) with 403. Agent-side tooling MUST set
   `x-agent-role` on API callbacks so this guard holds.
2. **Consent cards are host-owned.** Actions needing human approval use the
   consent-card protocol (`consent.ts`); `recordDecision()` throws for any
   agent actor. Agents cannot answer, bypass, or pre-approve them.
3. **Least privilege per tool.** A tool is visible only to its manifest's
   roles, and execution re-checks the invoking role — even if a tool
   definition leaked to the wrong role, the call fails closed.
4. **No secrets in plugins.** Plugin settings that are secrets are stored as
   vault references (`plugin_settings` table), never plaintext.

## Managing plugins (humans only)

- `POST /api/v1/plugins/install` with `{ "manifest": {…}, "origin": "local" }`
  → validates, stores `plugin.json` under the studio storage root, records
  the row with `install_state: "not-enabled"`, returns 201.
- `POST /api/v1/plugins/:id/enable` / `…/disable` → flips `install_state`.
- `GET /api/v1/plugins` → lists the registry.

Install and enable are separate steps on purpose: installing never activates.

## Example plugins (shipped)

- **`procedural-geometry`** — deterministic mesh generation
  (`box|sphere|plane|terrain`) from a seeded spec. Same seed → identical
  mesh, always. Pure computation, no side effects.
- **`asset-thumbnail`** — real thumbnails for uploaded PNG assets: pure-TS
  PNG decode (8-bit RGB/RGBA, non-interlaced), box-filter downscale to
  128px, PNG re-encode, written next to the asset store. Anything else
  returns `unsupported_format` — never a fabricated image.

A Blender adapter example is **deferred until the production server's
OS/architecture/RAM is inspected** (Phase 7) — shipping one blind would be
dishonest about what it can actually run.

## Writing your own

1. Copy `plugins/procedural-geometry` as a skeleton.
2. Write your `plugin.json`; validate it with the SDK in a test.
3. Implement the tool handler against the `ToolCallEnvelope` /
   `ToolResultEnvelope` types; keep handlers pure and deterministic where
   the domain allows it.
4. Add vitest tests: determinism, typed errors, protocol round-trip.
5. Install via the API and enable it — then check the role toolsets to
   confirm only your declared roles can call it.

## Checklist before publishing a plugin

- [ ] Manifest validates; coherence check passes.
- [ ] Tool names follow `<plugin>__<tool>`.
- [ ] `roles` lists exactly the roles that need the tool.
- [ ] Handlers return typed errors, never fake output.
- [ ] No secrets in code or defaults; secret settings use vault references.
- [ ] Tests cover the tool protocol, including the failure paths.
- [ ] You have read the trust model above and your plugin respects it.
