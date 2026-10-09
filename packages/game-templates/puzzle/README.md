# puzzle

Classic 15-puzzle on canvas: click a tile adjacent to the empty cell to slide it.
The board is shuffled with 120 seeded *valid* moves from solved — always solvable.
Move counter and solved detection included.

## Controls

- Click / tap a tile next to the empty cell.

## Contract notes

- `state()` → `{ grid: [16 numbers, 0 = empty], moves, solved }`.
- Scripted input: `{ tile: <value> }`.
- `world.js` also exports `createSolvedWorld()`, `moveTile(world, tile)` and
  `isSolved(grid)` for scripted win-path tests.

## How to extend

- Board size: `SIZE` constant. A match-3 variant would reuse the seeded-shuffle
  and scripted-input discipline.
