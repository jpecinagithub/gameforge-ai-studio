import type { AgentEvent } from './types';

export type ConsoleEventTag = 'status' | 'log' | 'tool_call' | 'tool_result' | 'error';

export interface ConsoleEventLine {
  tag: ConsoleEventTag;
  text: string;
  ok?: boolean;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function statusName(value: unknown): string {
  const raw = text(value) ?? 'thinking';
  if (raw === 'queued') return 'started';
  if (raw === 'planning' || raw === 'running') return 'thinking';
  if (raw === 'completed') return 'completed';
  return raw;
}

/** Convert the internal event journal into the concise agent-console protocol. */
export function formatConsoleEvent(event: AgentEvent): ConsoleEventLine {
  const payload = event.payload ?? {};
  switch (event.kind) {
    case 'run_created':
      return { tag: 'status', text: 'started' };
    case 'status_changed':
      return { tag: 'status', text: statusName(payload.to) };
    case 'build_started':
      return { tag: 'status', text: 'building' };
    case 'build_finished':
      return { tag: 'status', text: statusName(payload.verdict ?? payload.status ?? 'completed') };
    case 'paused':
      return { tag: 'status', text: 'paused' };
    case 'resumed':
      return { tag: 'status', text: 'thinking' };
    case 'stopped':
      return { tag: 'status', text: 'stopped' };
    case 'completed':
      return { tag: 'status', text: 'completed' };
    case 'tool_call': {
      const tool = text(payload.tool) ?? 'tool';
      return { tag: 'tool_call', text: `${tool}(${json(payload.args ?? {})})` };
    }
    case 'tool_result': {
      const ok = payload.ok !== false;
      const summary = text(payload.summary);
      return {
        tag: 'tool_result',
        text: `${ok ? 'ok' : 'error'}${summary ? `\n${summary}` : ''}`,
        ok,
      };
    }
    case 'error':
      return {
        tag: 'error',
        text: text(payload.detail) ?? text(payload.message) ?? text(payload.code) ?? json(payload),
        ok: false,
      };
    case 'progress':
    case 'decision':
    case 'plan_updated':
    case 'model_call':
    case 'question_asked':
    case 'question_answered':
    case 'test_result':
    case 'review_result':
    case 'artifact_saved':
    case 'retry': {
      const message = text(payload.summary)
        ?? text(payload.detail)
        ?? text(payload.question)
        ?? text(payload.message)
        ?? text(payload.step)
        ?? json(payload);
      return { tag: 'log', text: json({ text: message }) };
    }
    default:
      return { tag: 'log', text: json(payload) };
  }
}

