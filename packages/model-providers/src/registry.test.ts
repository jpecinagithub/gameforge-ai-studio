import { describe, expect, it } from 'vitest';
import {
  CONSERVATIVE_DEFAULTS,
  CURATED_CAPABILITIES_AS_OF,
  ModelRegistry,
  probeVisionSupport,
} from './registry.js';
import { ModelUnavailableError } from './errors.js';

/** Minimal fake client — only listModels is needed by refresh(). */
function fakeClient(modelIds: string[]) {
  return { listModels: async () => modelIds } as never;
}

describe('ModelRegistry refresh', () => {
  it('registers curated models with curated capabilities', async () => {
    const reg = new ModelRegistry();
    const report = await reg.refresh(fakeClient(['openai/gpt-oss-120b']));
    expect(report.added).toEqual(['openai/gpt-oss-120b']);
    const caps = reg.getCapabilities('openai/gpt-oss-120b');
    expect(caps?.supports_tools).toBe(true);
    expect(caps?.supports_vision).toBe(false);
    expect(reg.isActive('openai/gpt-oss-120b')).toBe(true);
  });

  it('unknown models get conservative defaults (no tools, no vision)', async () => {
    const reg = new ModelRegistry();
    await reg.refresh(fakeClient(['some/future-model-xyz']));
    expect(reg.getCapabilities('some/future-model-xyz')).toEqual(CONSERVATIVE_DEFAULTS);
  });

  it('disappeared models are deactivated, never deleted', async () => {
    const reg = new ModelRegistry();
    await reg.refresh(fakeClient(['openai/gpt-oss-120b', 'gone/model']));
    const report = await reg.refresh(fakeClient(['openai/gpt-oss-120b']));
    expect(report.deactivated).toEqual(['gone/model']);
    expect(reg.isActive('gone/model')).toBe(false);
    // History keeps its meaning: capabilities still queryable.
    expect(reg.getCapabilities('gone/model')).toBeDefined();
  });

  it('reappearing models are reactivated', async () => {
    const reg = new ModelRegistry();
    await reg.refresh(fakeClient(['m1']));
    await reg.refresh(fakeClient([]));
    expect(reg.isActive('m1')).toBe(false);
    const report = await reg.refresh(fakeClient(['m1']));
    expect(report.reactivated).toEqual(['m1']);
  });

  it('curated table is date-stamped', () => {
    expect(CURATED_CAPABILITIES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('ModelRegistry selectModel', () => {
  it('selects a tool-capable model for orchestration without naming models', async () => {
    const reg = new ModelRegistry();
    await reg.refresh(fakeClient(['openai/gpt-oss-120b', 'plain/model']));
    const picked = reg.selectModel({ role: 'director', requiresTools: true });
    expect(picked).toBe('openai/gpt-oss-120b');
  });

  it('refuses vision requirement when no vision model is registered', async () => {
    const reg = new ModelRegistry();
    await reg.refresh(fakeClient(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']));
    const err = (() => {
      try {
        reg.selectModel({ role: 'reviewer', requiresVision: true });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect((err as ModelUnavailableError).missingCapability).toBe('vision');
    expect((err as Error).message).toContain('vision');
    expect((err as Error).message).toContain('reviewer');
  });

  it('selects a vision model when one is available', async () => {
    const reg = new ModelRegistry();
    await reg.refresh(
      fakeClient(['openai/gpt-oss-120b', 'meta-llama/llama-4-scout-17b-16e-instruct']),
    );
    const picked = reg.selectModel({ role: 'reviewer', requiresVision: true });
    expect(picked).toBe('meta-llama/llama-4-scout-17b-16e-instruct');
  });

  it('throws on an empty registry', async () => {
    const reg = new ModelRegistry();
    expect(() => reg.selectModel({ role: 'director' })).toThrow(ModelUnavailableError);
  });

  it('is deterministic for tied candidates', async () => {
    const reg = new ModelRegistry();
    await reg.refresh(fakeClient(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']));
    const a = reg.selectModel({ role: 'director', requiresTools: true });
    const b = reg.selectModel({ role: 'director', requiresTools: true });
    expect(a).toBe(b);
  });
});

describe('probeVisionSupport', () => {

  function visionClient(behavior: 'ok' | 'empty' | 'throws' | 'text-only') {
    return {
      chatCompletions: async (opts: { messages: unknown[] }) => {
        // The probe must send an image_url content part (not plain text).
        const parts = (opts.messages[0] as { content: unknown[] }).content;
        const hasImage = parts.some(
          (p) => typeof p === 'object' && p !== null && (p as { type: string }).type === 'image_url',
        );
        if (!hasImage) throw new Error('probe sent no image part');
        if (behavior === 'throws') throw new Error('network down');
        if (behavior === 'empty') return { content: '   ', toolCalls: [] };
        if (behavior === 'text-only') return { content: 'OK', toolCalls: [] };
        return { content: 'OK', toolCalls: [] };
      },
    } as never;
  }

  it('true when the model returns non-empty content for the image probe', async () => {
    expect(await probeVisionSupport(visionClient('ok'), 'm')).toBe(true);
  });

  it('false on empty content (inconclusive, never proof of vision)', async () => {
    expect(await probeVisionSupport(visionClient('empty'), 'm')).toBe(false);
  });

  it('false on network error (inconclusive)', async () => {
    expect(await probeVisionSupport(visionClient('throws'), 'm')).toBe(false);
  });
});
