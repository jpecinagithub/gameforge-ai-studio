import { useTranslation } from 'react-i18next';
import type { BuildStatusValue, RunStatusValue } from '../types';

/**
 * Status pills render typed status codes — never English-text matching.
 * Tone is a pure lookup table; labels come from i18n.
 */

type Tone = 'neutral' | 'info' | 'active' | 'good' | 'warn' | 'bad';

const RUN_TONE: Record<RunStatusValue, Tone> = {
  queued: 'neutral',
  planning: 'info',
  running: 'active',
  waiting_for_user: 'warn',
  building: 'info',
  testing: 'info',
  reviewing: 'info',
  completed: 'good',
  failed: 'bad',
  canceled: 'neutral',
  interrupted: 'warn',
};

const BUILD_TONE: Record<BuildStatusValue, Tone> = {
  queued: 'neutral',
  building: 'info',
  testing: 'info',
  verifying: 'info',
  verified: 'good',
  partial: 'warn',
  failed: 'bad',
  canceled: 'neutral',
};

/** Pure mapping, exported for tests. Unknown values fail closed to 'neutral'. */
export function runTone(status: string): Tone {
  return (RUN_TONE as Record<string, Tone>)[status] ?? 'neutral';
}
export function buildTone(status: string): Tone {
  return (BUILD_TONE as Record<string, Tone>)[status] ?? 'neutral';
}

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/30',
  info: 'bg-sky-500/15 text-sky-400 ring-sky-500/30',
  active: 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/40',
  good: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-400 ring-amber-500/30',
  bad: 'bg-red-500/15 text-red-400 ring-red-500/30',
};

interface Props {
  kind: 'run' | 'build';
  status: string;
  className?: string;
}

export function StatusPill({ kind, status, className = '' }: Props) {
  const { t } = useTranslation();
  const tone = kind === 'run' ? runTone(status) : buildTone(status);
  const label = t(`status.${kind}.${status}`, { defaultValue: status });
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASSES[tone]} ${className}`}
      title={label}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}
