import { useEffect, useState } from 'react';
import {
  Atom,
  Box,
  Car,
  Crosshair,
  Gamepad2,
  Mountain,
  PersonStanding,
  Puzzle,
  type LucideIcon,
} from 'lucide-react';

interface Palette {
  /** rgba() color for the radial glow */
  glow: string;
  /** #rrggbb accent used for the icon, ring and badge */
  accent: string;
}

/**
 * Curated dark-friendly palettes (kept restrained to match the zinc/cyan
 * studio aesthetic). The palette is picked deterministically from the
 * project id so every project always renders the same thumbnail.
 */
const PALETTES: Palette[] = [
  { glow: 'rgba(34,211,238,0.28)', accent: '#22d3ee' },
  { glow: 'rgba(167,139,250,0.26)', accent: '#a78bfa' },
  { glow: 'rgba(52,211,153,0.24)', accent: '#34d399' },
  { glow: 'rgba(251,191,36,0.22)', accent: '#fbbf24' },
  { glow: 'rgba(251,113,133,0.24)', accent: '#fb7185' },
  { glow: 'rgba(96,165,250,0.26)', accent: '#60a5fa' },
];

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  'arcade-2d': Gamepad2,
  racing: Car,
  'platformer-3d': Mountain,
  puzzle: Puzzle,
  'first-person': Crosshair,
  'third-person': PersonStanding,
  'physics-sandbox': Atom,
  'empty-three': Box,
};

/** FNV-1a 32-bit hash — deterministic across renders and devices. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function normalize(v: string): string {
  return v.toLowerCase().replace(/_/g, '-');
}

export function iconForProject(template?: string, kind?: string | null): LucideIcon {
  const keys = [template, kind].filter((v): v is string => Boolean(v)).map(normalize);
  for (const k of keys) {
    const icon = TEMPLATE_ICONS[k];
    if (icon) return icon;
  }
  return Gamepad2;
}

export function labelForProject(template?: string, kind?: string | null): string | null {
  const raw = kind || template;
  return raw ? raw.replace(/[-_]/g, ' ') : null;
}

export function paletteForProject(projectId: string): Palette {
  return PALETTES[hashString(projectId) % PALETTES.length];
}

/** Infer a trustworthy MIME type from the artifact file name. */
export function mimeForArtifact(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

/**
 * Generative fallback: deterministic gradient + template icon.
 * Used while the real screenshot loads, and when the project has none.
 */
function GenerativeThumbnail({
  projectId,
  template,
  kind,
}: {
  projectId: string;
  template?: string;
  kind?: string | null;
}) {
  const palette = paletteForProject(projectId);
  const Icon = iconForProject(template, kind);
  const label = labelForProject(template, kind);

  return (
    <div
      aria-hidden="true"
      className="relative aspect-video w-full overflow-hidden"
      style={{
        background: `radial-gradient(120% 90% at 20% 10%, ${palette.glow} 0%, rgba(9,9,13,0) 60%), linear-gradient(160deg, #12121a 0%, #0a0a10 100%)`,
      }}
    >
      {/* subtle dot grid */}
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)',
          backgroundSize: '14px 14px',
        }}
      />
      {/* centered template icon */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-2xl border"
          style={{
            borderColor: `${palette.accent}55`,
            backgroundColor: `${palette.accent}14`,
          }}
        >
          <Icon className="h-7 w-7" style={{ color: palette.accent }} aria-hidden="true" />
        </div>
      </div>
      {/* template / genre badge */}
      {label && (
        <div className="absolute bottom-2 left-2">
          <span className="rounded-md bg-black/50 px-2 py-0.5 text-[11px] font-medium capitalize text-zinc-300 backdrop-blur-sm">
            {label}
          </span>
        </div>
      )}
    </div>
  );
}

export interface ScreenshotSource {
  /** Absolute API download URL for the screenshot artifact. */
  downloadUrl: string;
  /** Artifact file name (used to infer the MIME type). */
  name: string;
}

interface ProjectThumbnailProps {
  projectId: string;
  template?: string;
  kind?: string | null;
  /**
   * Real screenshot from the project's latest verified build. Takes
   * precedence over the generative art once loaded.
   *
   * The artifact download endpoint serves `application/octet-stream` with
   * `nosniff`, which browsers refuse to render in an <img>. We fetch the
   * bytes and re-wrap them in a Blob with the real image MIME type so the
   * screenshot displays correctly.
   */
  screenshot?: ScreenshotSource | null;
}

/**
 * Project card thumbnail: the real game screenshot when the project has a
 * verified build with visual evidence, generative art otherwise (also shown
 * while the screenshot loads). Decorative — the card already carries the
 * accessible project name.
 */
export function ProjectThumbnail({ projectId, template, kind, screenshot }: ProjectThumbnailProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setObjectUrl(null);
    setFailed(false);
    if (!screenshot) return;
    let cancelled = false;
    let obj: string | null = null;
    (async () => {
      try {
        const res = await fetch(screenshot.downloadUrl);
        if (!res.ok) throw new Error(`screenshot fetch failed: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        obj = URL.createObjectURL(new Blob([buf], { type: mimeForArtifact(screenshot.name) }));
        setObjectUrl(obj);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [screenshot]);

  if (screenshot && !failed && objectUrl) {
    return (
      <div className="relative aspect-video w-full overflow-hidden bg-zinc-950">
        <img
          src={objectUrl}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
        />
      </div>
    );
  }
  return <GenerativeThumbnail projectId={projectId} template={template} kind={kind} />;
}
