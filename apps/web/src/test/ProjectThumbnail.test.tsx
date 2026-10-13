import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { render, screen, waitFor } from '@testing-library/react';
import {
  ProjectThumbnail,
  iconForProject,
  labelForProject,
  mimeForArtifact,
  paletteForProject,
} from '../components/ProjectThumbnail';
import { Gamepad2, Car, Puzzle, Crosshair } from 'lucide-react';

describe('ProjectThumbnail', () => {
  it('picks a deterministic palette per project id', () => {
    expect(paletteForProject('abc')).toEqual(paletteForProject('abc'));
    expect(paletteForProject('abc').accent).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('maps known templates to their icons, unknown to the default', () => {
    expect(iconForProject('racing')).toBe(Car);
    expect(iconForProject('puzzle')).toBe(Puzzle);
    expect(iconForProject('first-person')).toBe(Crosshair);
    expect(iconForProject('something-new')).toBe(Gamepad2);
    expect(iconForProject(undefined, undefined)).toBe(Gamepad2);
  });

  it('prefers kind over template for the badge label', () => {
    expect(labelForProject('arcade-2d', 'side-2d')).toBe('side 2d');
    expect(labelForProject('arcade-2d', null)).toBe('arcade 2d');
    expect(labelForProject(undefined, undefined)).toBeNull();
  });

  it('infers the image MIME type from the artifact name', () => {
    expect(mimeForArtifact('shot.png')).toBe('image/png');
    expect(mimeForArtifact('shot.JPG')).toBe('image/jpeg');
    expect(mimeForArtifact('shot.webp')).toBe('image/webp');
    expect(mimeForArtifact('shot.bin')).toBe('image/png');
  });

  it('renders the generative fallback without crashing', () => {
    const html = renderToString(
      <ProjectThumbnail projectId="p1" template="racing" kind="racing" />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('racing');
    // lucide icon renders an svg
    expect(html).toContain('<svg');
  });

  describe('real screenshot', () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = realFetch;
      vi.unstubAllGlobals();
    });

    it('shows the real screenshot once its bytes load', async () => {
      const bytes = new Uint8Array([137, 80, 78, 71]).buffer; // PNG magic
      globalThis.fetch = vi.fn(async () =>
        new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
      ) as unknown as typeof fetch;
      const createObjectURL = vi.fn((_blob: Blob) => 'blob:fake-screenshot');
      const revokeObjectURL = vi.fn((_url: string) => undefined);
      vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

      const { container, unmount } = render(
        <ProjectThumbnail
          projectId="p1"
          template="racing"
          screenshot={{ downloadUrl: 'https://api.example/artifacts/1/download', name: 'shot.png' }}
        />,
      );
      await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
      const img = container.querySelector('img')!;
      expect(img.getAttribute('src')).toBe('blob:fake-screenshot');
      expect(img.getAttribute('alt')).toBe('');
      // Blob re-wrapped with the real image MIME type (not octet-stream).
      expect(createObjectURL).toHaveBeenCalled();
      const blobArg = createObjectURL.mock.calls[0]?.[0];
      expect(blobArg?.type).toBe('image/png');
      unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-screenshot');
    });

    it('falls back to generative art when the screenshot fetch fails', async () => {
      globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
      const { container } = render(
        <ProjectThumbnail
          projectId="p1"
          template="racing"
          screenshot={{ downloadUrl: 'https://api.example/artifacts/1/download', name: 'shot.png' }}
        />,
      );
      await waitFor(() =>
        expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull(),
      );
      // Generative fallback shows the template badge.
      expect(screen.getByText('racing')).toBeDefined();
      expect(container.querySelector('img')).toBeNull();
    });
  });
});
