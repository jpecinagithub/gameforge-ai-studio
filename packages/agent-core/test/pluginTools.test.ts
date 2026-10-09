import { describe, it, expect } from 'vitest';
import {
  PluginRegistry,
  makeToolCall,
  parseToolResult,
} from '@gameforge/plugin-sdk';
import {
  allPluginToolDefs,
  createLocalPluginExecutor,
  mergedToolDefsForRole,
  refusingPluginExecutor,
  toolDefsForRoleWithPlugins,
} from '../src/pluginTools.js';
import { AgentCoreError } from '../src/errors.js';
import type { ToolContext } from '../src/tools.js';

const MANIFEST = {
  apiVersion: 'gameforge-plugin/v1',
  id: 'procedural-geometry',
  name: 'Procedural Geometry',
  version: '1.0.0',
  publisher: 'gameforge',
  description: 'meshes',
  capabilities: ['tools'],
  tools: [
    {
      name: 'generate',
      description: 'make a mesh',
      roles: ['asset', 'scene_visual'],
      timeoutMs: 5000,
    },
  ],
  panels: [],
};

function registry() {
  const r = new PluginRegistry();
  r.register(MANIFEST);
  return r;
}

function ctx(role: string): ToolContext {
  return {
    runId: 'run-1',
    projectId: 'proj-1',
    role: role as ToolContext['role'],
    workDir: '/tmp',
  } as ToolContext;
}

const echoExecutor = createLocalPluginExecutor({
  'procedural-geometry__generate': (env) =>
    parseToolResult({ callId: env.callId, ok: true, output: { echoed: env.input } }),
});

describe('plugin tool channel', () => {
  it('exposes plugin tools only to manifest-listed roles', () => {
    const reg = registry();
    expect(toolDefsForRoleWithPlugins('asset', reg, echoExecutor).map((d) => d.name)).toEqual([
      'procedural-geometry__generate',
    ]);
    expect(toolDefsForRoleWithPlugins('reviewer', reg, echoExecutor)).toEqual([]);
    expect(toolDefsForRoleWithPlugins('director', reg, echoExecutor)).toEqual([]);
  });

  it('fails closed on unknown roles', () => {
    const reg = registry();
    expect(() =>
      // @ts-expect-error unknown role
      toolDefsForRoleWithPlugins('president', reg, echoExecutor),
    ).toThrow();
  });

  it('never exposes install/enable/disable as tools', () => {
    const reg = registry();
    const names = allPluginToolDefs(reg, echoExecutor).map((d) => d.name);
    expect(names.some((n) => /install|enable|disable/.test(n))).toBe(false);
  });

  it('merged defs keep core tools first, then plugin tools', () => {
    const reg = registry();
    const defs = mergedToolDefsForRole('asset', reg, echoExecutor);
    expect(defs[0].name).toBe('readFile');
    expect(defs.map((d) => d.name)).toContain('procedural-geometry__generate');
  });

  it('executes through the envelope protocol and returns output', async () => {
    const reg = registry();
    const [def] = toolDefsForRoleWithPlugins('asset', reg, echoExecutor);
    const out = (await def.execute({ kind: 'box' }, ctx('asset'))) as {
      echoed: { kind: string };
    };
    expect(out.echoed.kind).toBe('box');
  });

  it('execution gate rejects roles not listed in the manifest', async () => {
    const reg = registry();
    const [def] = allPluginToolDefs(reg, echoExecutor);
    await expect(def.execute({}, ctx('reviewer'))).rejects.toThrow(AgentCoreError);
    await expect(def.execute({}, ctx('unknown' as never))).rejects.toThrow(
      AgentCoreError,
    );
  });

  it('surfaces plugin failures as typed errors', async () => {
    const reg = registry();
    const failing = createLocalPluginExecutor({
      'procedural-geometry__generate': (env) =>
        parseToolResult({
          callId: env.callId,
          ok: false,
          error: { code: 'boom', message: 'kaput' },
        }),
    });
    const [def] = toolDefsForRoleWithPlugins('asset', reg, failing);
    await expect(def.execute({}, ctx('asset'))).rejects.toThrow(AgentCoreError);
  });

  it('refusing executor never fakes output', async () => {
    const reg = registry();
    const [def] = toolDefsForRoleWithPlugins('asset', reg, refusingPluginExecutor());
    const err = await def.execute({}, ctx('asset')).catch((e) => e);
    expect(err).toBeInstanceOf(AgentCoreError);
    expect((err as AgentCoreError).detail?.code).toBe('plugin_backend_not_configured');
  });

  it('local executor rejects unknown tool names', async () => {
    const res = await echoExecutor(
      makeToolCall('nope__nope', 'c1', {}, { role: 'asset' }),
    );
    expect(res.ok).toBe(false);
  });
});
