import * as THREE from 'three';
import { createWorld, stepWorld } from './world.js';
import { installStudio, getWorld, markReady } from './studio.js';

function seedFromURL() {
  const m = /[?&]seed=(\d+)/.exec(location.search);
  return m ? parseInt(m[1], 10) >>> 0 : 1;
}

const world = createWorld(seedFromURL());

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 300);

scene.add(new THREE.HemisphereLight(0x9db4ff, 0x1a2030, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(10, 20, 12);
scene.add(sun);

const levelGroup = new THREE.Group();
scene.add(levelGroup);
const coinMeshes = [];

function buildLevel(w) {
  levelGroup.clear();
  coinMeshes.length = 0;
  const platMat = new THREE.MeshStandardMaterial({ color: 0x2f855a, roughness: 0.8 });
  for (const pl of w.platforms) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(pl.x1 - pl.x0, 1, 4), platMat);
    m.position.set((pl.x0 + pl.x1) / 2, pl.y - 0.5, 0);
    m.userData.tag = 'platform';
    levelGroup.add(m);
  }
  const coinGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.12, 20);
  coinGeo.rotateX(Math.PI / 2);
  const coinMat = new THREE.MeshStandardMaterial({
    color: 0xfbbf24, roughness: 0.3, metalness: 0.7, emissive: 0x92600a,
  });
  w.coins.forEach((c, i) => {
    const m = new THREE.Mesh(coinGeo, coinMat);
    m.position.set(c.x, c.y, 0);
    m.userData.tag = 'coin';
    m.visible = !c.taken;
    coinMeshes[i] = m;
    levelGroup.add(m);
  });
  // goal flag
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 3, 10),
    new THREE.MeshStandardMaterial({ color: 0xcbd5e1 }),
  );
  pole.position.set(w.goal.x, w.goal.y + 1.5, 0);
  pole.userData.tag = 'goal';
  levelGroup.add(pole);
  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.9),
    new THREE.MeshBasicMaterial({ color: 0x22c55e, side: THREE.DoubleSide }),
  );
  flag.position.set(w.goal.x + 0.75, w.goal.y + 2.5, 0);
  flag.userData.tag = 'goal-flag';
  levelGroup.add(flag);
}
buildLevel(world);

const player = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.4, 0.8, 4, 12),
  new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.5 }),
);
player.userData.tag = 'player';
scene.add(player);

function syncScene(w) {
  const p = w.player;
  player.position.set(p.x, p.y + 0.8, 0);
  w.coins.forEach((c, i) => {
    if (coinMeshes[i]) {
      coinMeshes[i].visible = !c.taken;
      coinMeshes[i].rotation.y = w.timeMs / 400;
    }
  });
  // Side-view camera follows the player on x
  camera.position.set(p.x, p.y + 3.2, 13);
  camera.lookAt(p.x, p.y + 1, 0);
  hud(w);
}

const hudEl = document.getElementById('hud');
function hud(w) {
  hudEl.textContent =
    `platformer-3d · coins ${w.coinsTaken}/${w.coins.length}` +
    (w.won ? ' · YOU WIN!' : '');
}

installStudio({
  scene,
  seed: world.seed,
  onSeed: (w) => {
    buildLevel(w);
    syncScene(w);
  },
  afterStep: syncScene,
  demos: {
    default(w) { w.paused = false; },
    'near-goal'(w) {
      w.coins.forEach((c) => { c.taken = true; });
      w.coinsTaken = w.coins.length;
      w.player.x = w.goal.x - 3;
      w.player.y = w.goal.y;
    },
    freeze(w) { w.paused = true; },
    unfreeze(w) { w.paused = false; },
  },
});

const input = { left: false, right: false, jump: false };
const KEYMAP = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'jump', KeyW: 'jump', ArrowUp: 'jump' };
addEventListener('keydown', (e) => {
  if (KEYMAP[e.code]) {
    input[KEYMAP[e.code]] = true;
    e.preventDefault();
  }
});
addEventListener('keyup', (e) => {
  if (KEYMAP[e.code]) input[KEYMAP[e.code]] = false;
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let firstFrame = true;
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, now - last);
  last = now;
  const w = getWorld();
  if (!w.paused) stepWorld(w, dt, input);
  syncScene(w);
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    markReady();
  }
}
syncScene(world);
requestAnimationFrame(loop);
