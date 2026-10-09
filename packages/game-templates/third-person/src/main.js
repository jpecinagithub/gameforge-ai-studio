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
scene.fog = new THREE.Fog(0x0b0e14, 30, 90);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 300);

scene.add(new THREE.HemisphereLight(0x9db4ff, 0x1a2030, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(12, 24, 8);
scene.add(sun);

const platGroup = new THREE.Group();
scene.add(platGroup);
function rebuildPlatforms(w) {
  platGroup.clear();
  w.platforms.forEach((pl, i) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(pl.w, pl.h, pl.d),
      new THREE.MeshStandardMaterial({
        color: i === 0 ? 0x1c2a44 : 0x7c3aed,
        roughness: 0.7,
      }),
    );
    m.position.set(pl.x, pl.y, pl.z);
    m.userData.tag = i === 0 ? 'ground' : 'platform';
    platGroup.add(m);
  });
}
rebuildPlatforms(world);

const player = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.45, 0.9, 4, 12),
  new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.5 }),
);
player.userData.tag = 'player';
scene.add(player);

function syncScene(w) {
  const p = w.player;
  // Capsule origin is its center; world tracks the feet.
  player.position.set(p.x, p.y + 0.85, p.z);
  player.rotation.y = p.yaw;
  // Follow camera: behind the facing direction, above.
  const behind = 7;
  camera.position.set(
    p.x - Math.sin(p.yaw) * behind,
    p.y + 4.5,
    p.z - Math.cos(p.yaw) * behind,
  );
  camera.lookAt(p.x, p.y + 1.0, p.z);
}

installStudio({
  scene,
  seed: world.seed,
  onSeed: (w) => {
    rebuildPlatforms(w);
    syncScene(w);
  },
  afterStep: syncScene,
  demos: {
    default(w) { w.paused = false; },
    freeze(w) { w.paused = true; },
    unfreeze(w) { w.paused = false; },
  },
  inspect: (w) => [
    { tag: 'player-feet', position: [w.player.x, w.player.y, w.player.z] },
  ],
});

const input = { forward: false, back: false, left: false, right: false, jump: false };
const KEYMAP = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', Space: 'jump' };
addEventListener('keydown', (e) => {
  if (KEYMAP[e.code]) {
    input[KEYMAP[e.code]] = true;
    if (e.code === 'Space') e.preventDefault();
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
