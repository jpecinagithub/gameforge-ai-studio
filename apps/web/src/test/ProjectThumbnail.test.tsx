import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import {
  ProjectThumbnail,
  iconForProject,
  labelForProject,
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

  it('renders a decorative thumbnail with the badge', () => {
    const html = renderToString(
      <ProjectThumbnail projectId="p1" template="racing" kind="racing" />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('racing');
    // lucide icon renders an svg
    expect(html).toContain('<svg');
  });
});
