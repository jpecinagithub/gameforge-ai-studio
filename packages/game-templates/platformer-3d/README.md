# platformer-3d

Side-view 3D platformer: run/jump across seeded platforms, collect 6 coins,
reach the green flag. Win requires ALL coins + touching the goal.

## Controls

- **A/D** or **←/→** run, **Space/W/↑** jump.

## Contract notes

- `state()` → `{ player: { x, y, onGround }, coinsTaken, coinsTotal, won }`.
- Scripted input: `{ left, right, jump }`.
- Demos: `default`, `near-goal` (all coins collected, player placed before the
  flag — useful for win-path verification), `freeze`, `unfreeze`.
- Tags: `platform`, `coin`, `goal`, `goal-flag`, `player`.

## How to extend

- Level gen: `createWorld` — gap/width/height distributions. Enemies would be
  another array stepped in `stepWorld` with the same seeded RNG discipline.
