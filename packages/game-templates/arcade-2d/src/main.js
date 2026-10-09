import { createWorld, stepWorld, W, H } from './world.js';
import { installStudio, getWorld, markReady } from './studio.js';

function seedFromURL() {
  const m = /[?&]seed=(\d+)/.exec(location.search);
  return m ? parseInt(m[1], 10) >>> 0 : 1;
}

const world = createWorld(seedFromURL());

const canvas = document.getElementById('game');
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d');

function draw(w) {
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, W, H);

  // bricks
  for (const br of w.bricks) {
    if (!br.alive) continue;
    ctx.fillStyle = br.hp > 1 ? '#f59e0b' : '#3b82f6';
    ctx.fillRect(br.x, br.y, 52, 24);
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillRect(br.x, br.y, 52, 4);
  }
  // paddle
  ctx.fillStyle = '#22d3ee';
  ctx.fillRect(w.paddle.x - 45, H - 46, 90, 14);
  // ball
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  ctx.arc(w.ball.x, w.ball.y, 8, 0, Math.PI * 2);
  ctx.fill();
  // HUD
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '15px system-ui';
  ctx.fillText(`score ${w.score}`, 12, 26);
  ctx.fillText(`lives ${w.lives}`, W - 70, 26);
  if (w.won) centerText('YOU WIN!');
  if (w.lost) centerText('GAME OVER');
}

function centerText(t) {
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 42px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(t, W / 2, H / 2);
  ctx.textAlign = 'left';
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
    { tag: 'paddle', position: [w.paddle.x, H - 46] },
    { tag: 'ball', position: [w.ball.x, w.ball.y] },
    { tag: 'bricks-left', position: [w.bricks.filter((b) => b.alive).length, 0] },
  ],
});

const input = { left: false, right: false };
let pointerX = null;
addEventListener('keydown', (e) => {
  if (e.code === 'ArrowLeft') input.left = true;
  if (e.code === 'ArrowRight') input.right = true;
});
addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft') input.left = false;
  if (e.code === 'ArrowRight') input.right = false;
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  pointerX = ((e.clientX - r.left) / r.width) * W;
});
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

let firstFrame = true;
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, now - last);
  last = now;
  const w = getWorld();
  if (!w.paused) {
    const scripted = pointerX !== null ? { paddleX: pointerX } : input;
    stepWorld(w, dt, scripted);
    pointerX = null; // consume once per frame; keys persist
  }
  draw(w);
  if (firstFrame) {
    firstFrame = false;
    markReady();
  }
}
draw(world);
requestAnimationFrame(loop);
