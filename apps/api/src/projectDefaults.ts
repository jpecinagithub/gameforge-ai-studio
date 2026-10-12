export type ProjectDefaults = {
  template: string;
  kind: string;
  engine: 'three' | 'canvas2d';
};

const includesAny = (text: string, terms: string[]): boolean =>
  terms.some((term) => text.includes(term));

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ');

/** Select a useful starter from the user's natural-language game description. */
export function inferProjectDefaults(name: string, description?: string): ProjectDefaults {
  const text = normalize(`${name} ${description ?? ''}`);

  if (includesAny(text, [
    'tetris', 'puzzle', 'rompecabezas', 'sudoku', 'tres en raya', '3 en raya',
    'tic tac toe', 'ajedrez', 'chess', 'juego de cartas', 'card game', 'tablero',
    'board game',
  ])) {
    return { template: 'puzzle', kind: 'static-board', engine: 'canvas2d' };
  }
  if (includesAny(text, ['plataforma', 'platform', 'mario', 'runner', 'jump', 'saltar'])) {
    return { template: 'three-platformer', kind: 'side-2d', engine: 'three' };
  }
  if (includesAny(text, ['carrera', 'racing', 'race', 'coche', 'car game', 'kart'])) {
    return { template: 'three-racing', kind: 'racing', engine: 'three' };
  }
  if (includesAny(text, ['primera persona', 'first person', 'fps', 'shooter'])) {
    return { template: 'three-fps', kind: 'first-person', engine: 'three' };
  }
  if (includesAny(text, ['tercera persona', 'third person', 'survival', 'supervivencia', 'arena'])) {
    return { template: 'three-third-person', kind: 'third-person', engine: 'three' };
  }
  if (includesAny(text, ['vuelo', 'flight', 'avion', 'airplane', 'nave espacial', 'spaceship'])) {
    return { template: 'three-empty', kind: 'flight', engine: 'three' };
  }
  if (includesAny(text, ['vista cenital', 'top down', 'estrategia', 'strategy'])) {
    return { template: 'arcade-2d', kind: 'top-down', engine: 'canvas2d' };
  }
  if (includesAny(text, ['fisica', 'physics', 'sandbox'])) {
    return { template: 'physics-sandbox', kind: 'free-camera', engine: 'three' };
  }
  if (includesAny(text, ['arcade', 'pixel art', 'juego 2d', 'game 2d'])) {
    return { template: 'arcade-2d', kind: 'side-2d', engine: 'canvas2d' };
  }

  return { template: 'three-empty', kind: 'free-camera', engine: 'three' };
}

export function engineForTemplate(template: string): 'three' | 'canvas2d' {
  return template === 'arcade-2d' || template === 'puzzle' ? 'canvas2d' : 'three';
}
