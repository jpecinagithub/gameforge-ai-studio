import { describe, expect, it, vi } from 'vitest';
import { appendEvent } from '../src/events.js';
import type { DbPool } from '../src/db.js';

interface Call {
  target: 'pool' | 'client';
  text: string;
  params: unknown[] | undefined;
}

/** Minimal in-memory pg double: records every query, programmable SELECTs. */
function createMockDb(selects: { match: RegExp; rows: unknown[] }[] = []) {
  const calls: Call[] = [];
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ target: 'client', text, params });
      if (/INSERT INTO agent_events/i.test(text)) {
        if ((client as { failInsert?: boolean }).failInsert) {
          throw new Error('insert boom');
        }
        return { rows: [], rowCount: 1 };
      }
      for (const s of selects) {
        if (s.match.test(text)) return { rows: s.rows, rowCount: s.rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool: DbPool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ target: 'pool', text, params });
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => client),
    end: vi.fn(async () => {}),
  };
  return { pool, client, calls };
}

const redactor = {
  redactDeep: (v: unknown) =>
    JSON.parse(JSON.stringify(v).replaceAll('SECRET123', '[REDACTED:test-secret]')),
};

describe('appendEvent', () => {
  it('redacts secrets BEFORE the insert (redaction-on-append)', async () => {
    const { pool, calls } = createMockDb([
      { match: /FOR UPDATE/, rows: [{}] },
      { match: /MAX\(seq\)/, rows: [{ max: '41' }] },
    ]);
    const { seq } = await appendEvent(
      pool,
      redactor,
      'run_01',
      'tool_result',
      { note: 'leaked SECRET123 here' },
    );
    expect(seq).toBe(42);
    const insert = calls.find((c) => /INSERT INTO agent_events/i.test(c.text));
    expect(insert).toBeDefined();
    const payloadJson = String(insert!.params![4]);
    expect(payloadJson).not.toContain('SECRET123');
    expect(payloadJson).toContain('[REDACTED:test-secret]');
    expect(insert!.params![0]).toBe('run_01');
    expect(insert!.params![1]).toBe(null); // no taskId
    expect(insert!.params![2]).toBe(42);
    expect(insert!.params![3]).toBe('tool_result');
  });

  it('serializes seq per run inside a transaction and releases the client', async () => {
    const { pool, client, calls } = createMockDb([
      { match: /FOR UPDATE/, rows: [{}] },
      { match: /MAX\(seq\)/, rows: [{ max: null }] },
    ]);
    const { seq } = await appendEvent(pool, redactor, 'run_01', 'decision', { a: 1 });
    expect(seq).toBe(1);
    const order = calls.map((c) => c.text.split('\n')[0].trim());
    expect(order[0]).toBe('BEGIN');
    expect(order).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back and rethrows when the insert fails', async () => {
    const { pool, client, calls } = createMockDb([
      { match: /FOR UPDATE/, rows: [{}] },
      { match: /MAX\(seq\)/, rows: [{ max: '0' }] },
    ]);
    (client as { failInsert?: boolean }).failInsert = true;
    await expect(
      appendEvent(pool, redactor, 'run_01', 'error', {}),
    ).rejects.toThrow('insert boom');
    expect(calls.some((c) => c.text === 'ROLLBACK')).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});
