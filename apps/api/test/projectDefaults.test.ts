import { describe, expect, it } from 'vitest';
import { inferProjectDefaults } from '../src/projectDefaults.js';

describe('inferProjectDefaults', () => {
  it.each([
    ['Neon Tetris', '', 'puzzle', 'static-board', 'canvas2d'],
    ['Tres en raya', 'Un tablero clásico', 'puzzle', 'static-board', 'canvas2d'],
    ['Astro Jump', 'Juego de plataformas 2D', 'three-platformer', 'side-2d', 'three'],
    ['Velocidad total', 'Carreras de coches', 'three-racing', 'racing', 'three'],
    ['Neon Arena', 'Supervivencia en tercera persona', 'three-third-person', 'third-person', 'three'],
    ['Sky Ace', 'Simulador de vuelo', 'three-empty', 'flight', 'three'],
  ])('classifies %s from its name and description', (name, description, template, kind, engine) => {
    expect(inferProjectDefaults(name, description)).toEqual({ template, kind, engine });
  });

  it('uses a neutral Three.js starter when the description is ambiguous', () => {
    expect(inferProjectDefaults('Mi juego')).toEqual({
      template: 'three-empty',
      kind: 'free-camera',
      engine: 'three',
    });
  });
});
