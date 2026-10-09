// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). World logic MUST use this — never Math.random.
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SIZE = 4;
export const CELLS = SIZE * SIZE;

export function solvedGrid() {
  return Array.from({ length: CELLS }, (_, i) => (i + 1) % CELLS);
}

function emptyIndex(grid) {
  return grid.indexOf(0);
}

function neighbors(idx) {
  const r = Math.floor(idx / SIZE);
  const c = idx % SIZE;
  const out = [];
  if (r > 0) out.push(idx - SIZE);
  if (r < SIZE - 1) out.push(idx + SIZE);
  if (c > 0) out.push(idx - 1);
  if (c < SIZE - 1) out.push(idx + 1);
  return out;
}

/** Move a tile value into the empty cell if adjacent. Returns true if moved. */
export function moveTile(world, tile) {
  const grid = world.grid;
  const ti = grid.indexOf(tile);
  const ei = emptyIndex(grid);
  if (ti === -1 || tile === 0) return false;
  if (!neighbors(ei).includes(ti)) return false;
  grid[ei] = tile;
  grid[ti] = 0;
  world.moves++;
  world.solved = isSolved(grid);
  return true;
}

export function isSolved(grid) {
  for (let i = 0; i < CELLS; i++) {
    if (grid[i] !== (i + 1) % CELLS) return false;
  }
  return true;
}

/** A solved board with no shuffle — useful for scripted win-path tests. */
export function createSolvedWorld() {
  return {
    seed: 0,
    paused: false,
    timeMs: 0,
    grid: solvedGrid(),
    moves: 0,
    solved: true,
  };
}

// Pure world: no canvas, no DOM. Importable in Node for tests.
// Shuffle = K random VALID moves from solved (guaranteed solvable).
export function createWorld(seed = 1) {
  const rand = mulberry32(seed);
  const world = createSolvedWorld();
  world.seed = seed >>> 0;
  world.solved = false;
  let lastEmpty = -1;
  for (let k = 0; k < 120; k++) {
    const ei = emptyIndex(world.grid);
    const opts = neighbors(ei).filter((n) => n !== lastEmpty);
    const pick = opts[Math.floor(rand() * opts.length)];
    world.grid[ei] = world.grid[pick];
    world.grid[pick] = 0;
    lastEmpty = ei;
  }
  world.moves = 0;
  // Extremely unlikely, but guard: never ship a solved "shuffled" board.
  if (isSolved(world.grid)) {
    const ei = emptyIndex(world.grid);
    const n = neighbors(ei)[0];
    world.grid[ei] = world.grid[n];
    world.grid[n] = 0;
  }
  return world;
}

// input: { tile: number } — the tile value the user clicked
export function stepWorld(world, dtMs, input = {}) {
  world.timeMs += Math.max(0, dtMs);
  if (world.solved) return;
  if (typeof input.tile === 'number') moveTile(world, input.tile);
}

export function getState(world) {
  return {
    seed: world.seed,
    timeMs: Math.round(world.timeMs),
    grid: [...world.grid],
    moves: world.moves,
    solved: world.solved,
  };
}
