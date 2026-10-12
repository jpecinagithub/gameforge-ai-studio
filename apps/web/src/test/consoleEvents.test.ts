import { describe, expect, it } from 'vitest';
import { formatConsoleEvent } from '../consoleEvents';
import type { AgentEvent } from '../types';

const event = (kind: string, payload: Record<string, unknown>): AgentEvent => ({
  id: 1,
  run_id: 'run_1',
  seq: 1,
  kind,
  payload,
  created_at: '2026-10-12T20:00:00.000Z',
});

describe('formatConsoleEvent', () => {
  it('uses the status/log/tool protocol', () => {
    expect(formatConsoleEvent(event('run_created', {}))).toEqual({ tag: 'status', text: 'started' });
    expect(formatConsoleEvent(event('status_changed', { to: 'running' }))).toEqual({ tag: 'status', text: 'thinking' });
    expect(formatConsoleEvent(event('progress', { summary: 'Creando archivos…' }))).toEqual({
      tag: 'log',
      text: '{"text":"Creando archivos…"}',
    });
    expect(formatConsoleEvent(event('tool_call', { tool: 'write_file', args: { path: 'src/main.ts' } }))).toEqual({
      tag: 'tool_call',
      text: 'write_file({"path":"src/main.ts"})',
    });
    expect(formatConsoleEvent(event('tool_call', { tool: 'listFiles', args: { dir: 'src' } }))).toEqual({
      tag: 'tool_call',
      text: 'list_files({"dir":"src"})',
    });
    expect(formatConsoleEvent(event('tool_result', { ok: true, summary: 'saved' }))).toEqual({
      tag: 'tool_result',
      text: 'ok\nsaved',
      ok: true,
    });
  });

  it('surfaces failures as error lines', () => {
    expect(formatConsoleEvent(event('error', { code: 'iteration_limit', detail: 'Máximo de iteraciones.' }))).toEqual({
      tag: 'error',
      text: 'Máximo de iteraciones.',
      ok: false,
    });
  });
});

