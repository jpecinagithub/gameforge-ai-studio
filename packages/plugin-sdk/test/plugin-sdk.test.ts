import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  fullToolName,
  checkManifestCoherence,
  PluginRegistry,
  makeToolCall,
  parseToolResult,
  backendNotConfigured,
  PLUGIN_PANEL_CSP,
  panelMessage,
  hostMessage,
  parsePanelMessage,
  createConsentCard,
  recordDecision,
  isApproved,
  ConsentError,
} from '../src/index.js';

const goodManifest = {
  apiVersion: 'gameforge-plugin/v1',
  id: 'procedural-geometry',
  name: 'Procedural Geometry',
  version: '1.0.0',
  publisher: 'gameforge',
  description: 'Deterministic procedural mesh generation',
  capabilities: ['tools'],
  tools: [
    {
      name: 'generate',
      description: 'Generate a mesh',
      inputSchema: { seed: 'number' },
      roles: ['asset', 'scene_visual'],
      timeoutMs: 10000,
    },
  ],
  panels: [],
};

describe('manifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseManifest(goodManifest);
    expect(m.id).toBe('procedural-geometry');
  });

  it('rejects wrong apiVersion', () => {
    expect(() => parseManifest({ ...goodManifest, apiVersion: 'v2' })).toThrow();
  });

  it('rejects uppercase plugin id', () => {
    expect(() => parseManifest({ ...goodManifest, id: 'Bad_ID' })).toThrow();
  });

  it('rejects non-semver version', () => {
    expect(() => parseManifest({ ...goodManifest, version: 'one' })).toThrow();
  });

  it('rejects unknown capability', () => {
    expect(() => parseManifest({ ...goodManifest, capabilities: ['teleport'] })).toThrow();
  });

  it('rejects unknown caller role in a tool', () => {
    const bad = {
      ...goodManifest,
      tools: [{ name: 'x', description: 'x', roles: ['president'] }],
    };
    expect(() => parseManifest(bad)).toThrow();
  });

  it('derives full tool names and enforces the <plugin>__<tool> rule', () => {
    expect(fullToolName('procedural-geometry', 'generate')).toBe(
      'procedural-geometry__generate',
    );
    expect(() => fullToolName('UPPER', 'generate')).toThrow();
  });

  it('rejects tools without the tools capability', () => {
    const m = parseManifest({ ...goodManifest, capabilities: ['panels'] });
    expect(() => checkManifestCoherence(m)).toThrow(/tools/);
  });

  it('rejects duplicate tool names', () => {
    const m = parseManifest({
      ...goodManifest,
      tools: [
        { name: 'generate', description: 'a', roles: [] },
        { name: 'generate', description: 'b', roles: [] },
      ],
    });
    expect(() => checkManifestCoherence(m)).toThrow(/Duplicate tool/);
  });
});

describe('registry', () => {
  it('registers and namespaces tools', () => {
    const reg = new PluginRegistry();
    const p = reg.register(goodManifest);
    expect(p.tools[0].fullName).toBe('procedural-geometry__generate');
    expect(reg.ids()).toEqual(['procedural-geometry']);
  });

  it('rejects duplicate plugin registration', () => {
    const reg = new PluginRegistry();
    reg.register(goodManifest);
    expect(() => reg.register(goodManifest)).toThrow(/already registered/);
  });

  it('filters tools by role; unknown roles get nothing', () => {
    const reg = new PluginRegistry();
    reg.register(goodManifest);
    expect(reg.toolNamesForRole('asset')).toEqual(['procedural-geometry__generate']);
    expect(reg.toolsForRole('reviewer')).toEqual([]);
    expect(reg.toolsForRole('nobody')).toEqual([]);
  });

  it('getTool resolves by full name', () => {
    const reg = new PluginRegistry();
    reg.register(goodManifest);
    expect(reg.getTool('procedural-geometry__generate')?.pluginId).toBe(
      'procedural-geometry',
    );
    expect(reg.getTool('nope__nope')).toBeUndefined();
  });
});

describe('tool protocol', () => {
  it('validates a well-formed call envelope', () => {
    const env = makeToolCall(
      'procedural-geometry__generate',
      'call-1',
      { seed: 42 },
      { role: 'asset' },
    );
    expect(env.tool).toBe('procedural-geometry__generate');
  });

  it('rejects non-namespaced tool names', () => {
    expect(() =>
      makeToolCall('generate', 'call-1', {}, { role: 'asset' }),
    ).toThrow();
  });

  it('validates success and failure results', () => {
    const ok = parseToolResult({ callId: 'c1', ok: true, output: { n: 1 } });
    expect(ok.ok).toBe(true);
    const fail = parseToolResult({
      callId: 'c2',
      ok: false,
      error: { code: 'bad', message: 'nope' },
    });
    expect(fail.error?.code).toBe('bad');
  });

  it('rejects contradictory results', () => {
    expect(() =>
      parseToolResult({ callId: 'c', ok: true, error: { code: 'x', message: 'y' } }),
    ).toThrow();
    expect(() => parseToolResult({ callId: 'c', ok: false })).toThrow();
  });

  it('backendNotConfigured refuses honestly instead of faking output', () => {
    const r = backendNotConfigured('c9');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('plugin_backend_not_configured');
  });
});

describe('panel bridge', () => {
  it('round-trips typed messages and rejects foreign traffic', () => {
    const m = panelMessage('panel:ready', 'p', 'main', 0);
    expect(parsePanelMessage(m)?.kind).toBe('panel:ready');
    const h = hostMessage('host:init', 'p', 'main', 1, { theme: 'dark' });
    expect(parsePanelMessage(h)?.payload.theme).toBe('dark');
    expect(parsePanelMessage({ kind: 'panel:ready' })).toBeNull();
    expect(parsePanelMessage({ protocol: 'other', kind: 'panel:ready' })).toBeNull();
  });

  it('rejects panel→host kinds on hostMessage and vice versa', () => {
    // @ts-expect-error intentional misuse: hostMessage must not build panel: kinds
    expect(() => hostMessage('panel:ready', 'p', 'main', 0)).toThrow();
  });

  it('CSP is strict: no network, no top navigation', () => {
    expect(PLUGIN_PANEL_CSP).toContain("connect-src 'none'");
    expect(PLUGIN_PANEL_CSP).toContain("frame-ancestors 'none'");
  });
});

describe('consent protocol', () => {
  it('a human can approve a consent card', () => {
    const card = createConsentCard({
      id: 'cc-1',
      pluginId: 'p',
      title: 'Enable plugin',
      body: 'Grants tool access.',
    });
    const decided = recordDecision(card, 'approved', { kind: 'human' });
    expect(isApproved(decided)).toBe(true);
    expect(decided.decidedBy?.kind).toBe('human');
  });

  it('an agent can NEVER decide a consent card', () => {
    const card = createConsentCard({
      id: 'cc-2',
      pluginId: 'p',
      title: 'Enable plugin',
      body: 'Grants tool access.',
    });
    expect(() =>
      recordDecision(card, 'approved', { kind: 'agent', id: 'agent:director' }),
    ).toThrow(ConsentError);
    // Card stays undecided.
    expect(card.decision).toBeNull();
  });

  it('rejects double decisions', () => {
    const card = createConsentCard({
      id: 'cc-3',
      pluginId: 'p',
      title: 't',
      body: 'b',
    });
    const once = recordDecision(card, 'denied', { kind: 'human' });
    expect(() => recordDecision(once, 'approved', { kind: 'human' })).toThrow(
      ConsentError,
    );
  });
});
