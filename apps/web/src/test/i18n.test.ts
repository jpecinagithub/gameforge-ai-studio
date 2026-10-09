import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import es from '../i18n/es.json';

type Dict = Record<string, unknown>;

function flatten(obj: Dict, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flatten(v as Dict, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe('i18n dictionary parity (en/es)', () => {
  it('has identical key sets in both languages', () => {
    const enKeys = flatten(en as Dict);
    const esKeys = flatten(es as Dict);
    const missingInEs = enKeys.filter((k) => !esKeys.includes(k));
    const missingInEn = esKeys.filter((k) => !enKeys.includes(k));
    expect(
      missingInEs,
      `keys missing in es.json: ${missingInEs.join(', ')}`,
    ).toEqual([]);
    expect(
      missingInEn,
      `keys missing in en.json: ${missingInEn.join(', ')}`,
    ).toEqual([]);
  });

  it('has no empty translation strings', () => {
    for (const [lang, dict] of [['en', en], ['es', es]] as const) {
      const check = (obj: Dict, path: string) => {
        for (const [k, v] of Object.entries(obj)) {
          const p = path ? `${path}.${k}` : k;
          if (typeof v === 'string') {
            expect(v.trim().length, `${lang}:${p} is empty`).toBeGreaterThan(0);
          } else if (v && typeof v === 'object') {
            check(v as Dict, p);
          }
        }
      };
      check(dict as Dict, '');
    }
  });

  it('covers every run and build status label', () => {
    const run = (en as Dict).status as Dict;
    const runLabels = run.run as Dict;
    const buildLabels = run.build as Dict;
    const expectedRun = [
      'queued', 'planning', 'running', 'waiting_for_user', 'building',
      'testing', 'reviewing', 'completed', 'failed', 'canceled', 'interrupted',
    ];
    const expectedBuild = [
      'queued', 'building', 'testing', 'verifying',
      'verified', 'partial', 'failed', 'canceled',
    ];
    for (const s of expectedRun) expect(runLabels[s], `run.${s}`).toBeTruthy();
    for (const s of expectedBuild) expect(buildLabels[s], `build.${s}`).toBeTruthy();
  });
});
