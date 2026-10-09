import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { StatusPill, buildTone, runTone } from '../components/StatusPill';

// Every value of the typed status enums (packages/shared/src/enums.ts).
// Rendered from the enum — never by matching English text.
const ALL_RUN_STATUSES = [
  'queued', 'planning', 'running', 'waiting_for_user', 'building',
  'testing', 'reviewing', 'completed', 'failed', 'canceled', 'interrupted',
];
const ALL_BUILD_STATUSES = [
  'queued', 'building', 'testing', 'verifying',
  'verified', 'partial', 'failed', 'canceled',
];

describe('StatusPill', () => {
  it('renders every RunStatus without crashing', () => {
    for (const status of ALL_RUN_STATUSES) {
      const html = renderToString(
        <I18nextProvider i18n={i18n}>
          <StatusPill kind="run" status={status} />
        </I18nextProvider>,
      );
      expect(html.length).toBeGreaterThan(0);
      expect(html).toContain('rounded-full');
    }
  });

  it('renders every BuildStatus without crashing', () => {
    for (const status of ALL_BUILD_STATUSES) {
      const html = renderToString(
        <I18nextProvider i18n={i18n}>
          <StatusPill kind="build" status={status} />
        </I18nextProvider>,
      );
      expect(html.length).toBeGreaterThan(0);
    }
  });

  it('fails closed to neutral tone for unknown statuses', () => {
    expect(runTone('nope')).toBe('neutral');
    expect(buildTone('nope')).toBe('neutral');
  });

  it('assigns the terminal failure tone to failed builds and runs', () => {
    expect(runTone('failed')).toBe('bad');
    expect(buildTone('failed')).toBe('bad');
    expect(buildTone('verified')).toBe('good');
    expect(runTone('completed')).toBe('good');
    expect(runTone('waiting_for_user')).toBe('warn');
  });
});
