import { createWorld, stepWorld, SIZE, CELLS } from './world.js';
import { installStudio, getWorld, markReady } from './studio.js';

function seedFromURL() {
  const m = /[?&]seed=(\d+)/.exec(location.search);
  return m ? parseInt(m[1], 10) >>> 0 : 1;
}

const world = createWorld(seedFromURL());

const canvas = document.getElementById('game');
const N = 440;
canvas.width = N;
canvas.height = N + 60;
const ctx = canvas.getContext('2d');
const CELL = N / SIZE;

function draw(w) {
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < CELLS; i++) {
    const v = w.grid[i];
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;
    const x = c * CELL;
    const y = r * CELL;
    if (v === 0) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(x + 3, y + 3, CELL - 6, CELL - 6);
      continue;
    }
    const hue = (v * 23) % 360;
    ctx.fillStyle = `hsl(${hue} 60% 42%)`;
    ctx.fillRect(x + 3, y + 3, CELL - 6, CELL - 6);
    ctx.fillStyle = '#f8fafc';
    ctx.font = `bold ${CELL / 3}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(v), x + CELL / 2, y + CELL / 2);
  }
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '15px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`moves: ${w.moves}`, 12, N + 34);
  if (w.solved) {
    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 17px system-ui';
    ctx.fillText('SOLVED!', N - 90, N + 34);
  }
}

installStudio({
  seed: world.seed,
  onSeed: draw,
  afterStep: draw,
  demos: {
    default(w) { w.paused = false; },
    freeze(w) { w.paused = true; },
    unfreeze(w) { w.paused = false; },
  },
  inspect: (w) => [
    { tag: 'grid', position: w.grid.slice() },
    { tag: 'moves', position: [w.moves, 0] },
  ],
});

canvas.addEventListener('click', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * N;
  const y = ((e.clientY - r.top) / r.height) * (N + 60);
  if (y >= N) return;
  const c = Math.floor(x / CELL);
  const rr = Math.floor(y / CELL);
  const idx = rr * SIZE + c;
  const w = getWorld();
  if (!w.paused) stepWorld(w, 0, { tile: w.grid[idx] });
  draw(w);
});

let firstFrame = true;
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, now - last);
  last = now;
  const w = getWorld();
  if (!w.paused) stepWorld(w, dt, {});
  draw(w);
  if (firstFrame) {
    firstFrame = false;
    markReady();
  }
}
draw(world);
requestAnimationFrame(loop);
