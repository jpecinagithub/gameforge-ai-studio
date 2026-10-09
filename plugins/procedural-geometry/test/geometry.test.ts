import { describe, it, expect } from 'vitest';
import { generateMesh } from '../src/geometry.js';
import { handleGenerate } from '../src/index.js';
import { makeToolCall } from '@gameforge/plugin-sdk';

describe('generateMesh', () => {
  it('generates a box with 8 vertices and 12 faces', () => {
    const m = generateMesh({ kind: 'box', seed: 1 });
    expect(m.vertices).toHaveLength(8);
    expect(m.faces).toHaveLength(12);
    expect(m.seed).toBe(1);
  });

  it('is deterministic: same seed → identical mesh', () => {
    const a = generateMesh({ kind: 'terrain', seed: 42, detail: 16 });
    const b = generateMesh({ kind: 'terrain', seed: 42, detail: 16 });
    expect(a).toEqual(b);
  });

  it('different seeds → different meshes', () => {
    const a = generateMesh({ kind: 'sphere', seed: 1, detail: 8 });
    const b = generateMesh({ kind: 'sphere', seed: 2, detail: 8 });
    expect(a.vertices).not.toEqual(b.vertices);
  });

  it('terrain stays within the size bounds', () => {
    const m = generateMesh({ kind: 'terrain', seed: 7, size: 10, detail: 16 });
    for (const [x, , z] of m.vertices) {
      expect(Math.abs(x)).toBeLessThanOrEqual(5.001);
      expect(Math.abs(z)).toBeLessThanOrEqual(5.001);
    }
  });

  it('plane detail controls grid resolution', () => {
    const d1 = generateMesh({ kind: 'plane', seed: 1, detail: 2 });
    const d2 = generateMesh({ kind: 'plane', seed: 1, detail: 4 });
    expect(d2.vertices.length).toBeGreaterThan(d1.vertices.length);
  });

  it('rejects invalid input', () => {
    expect(() => generateMesh({ kind: 'box', seed: 1.5 })).toThrow();
    expect(() => generateMesh({ kind: 'box', seed: 1, size: -1 })).toThrow();
    // @ts-expect-error unknown kind
    expect(() => generateMesh({ kind: 'torus', seed: 1 })).toThrow();
  });
});

describe('handleGenerate (tool protocol)', () => {
  it('answers a valid tool call envelope with real mesh JSON', () => {
    const env = makeToolCall(
      'procedural-geometry__generate',
      'c1',
      { kind: 'box', seed: 3 },
      { role: 'asset' },
    );
    const res = handleGenerate(env);
    expect(res.ok).toBe(true);
    const out = res.output as { vertexCount: number; vertices: unknown[] };
    expect(out.vertexCount).toBe(8);
    expect(out.vertices).toHaveLength(8);
  });

  it('returns typed errors for unknown tools and bad input', () => {
    const badTool = makeToolCall('procedural-geometry__nope', 'c2', {}, { role: 'asset' });
    expect(handleGenerate(badTool).error?.code).toBe('unknown_tool');
    const badInput = makeToolCall(
      'procedural-geometry__generate',
      'c3',
      { kind: 'torus', seed: 1 },
      { role: 'asset' },
    );
    expect(handleGenerate(badInput).error?.code).toBe('invalid_input');
  });
});
