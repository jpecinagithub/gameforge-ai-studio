import * as THREE from 'three';
import { createWorld, stepWorld, ARENA_HALF } from './world.js';
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
scene.fog = new THREE.Fog(0x0b0e14, 20, 70);

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 200);

scene.add(new THREE.HemisphereLight(0x9db4ff, 0x1a2030, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(12, 20, 8);
scene.add(sun);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
  new THREE.MeshStandardMaterial({ color: 0x16202e, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.userData.tag = 'floor';
scene.add(floor);

// Walls
const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b3a55, roughness: 0.8 });
function wall(w, h, d, x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
  m.position.set(x, h / 2, z);
  m.userData.tag = 'wall';
  scene.add(m);
}
wall(ARENA_HALF * 2 + 1, 4, 1, 0, -ARENA_HALF);
wall(ARENA_HALF * 2 + 1, 4, 1, 0, ARENA_HALF);
wall(1, 4, ARENA_HALF * 2 + 1, -ARENA_HALF, 0);
wall(1, 4, ARENA_HALF * 2 + 1, ARENA_HALF, 0);

// Obstacles (rebuilt on reseed)
const obstacleGroup = new THREE.Group();
obstacleGroup.userData.tag = 'obstacles';
scene.add(obstacleGroup);
const obstacleMat = new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.6 });
function rebuildObstacles(w) {
  obstacleGroup.clear();
  for (const o of w.obstacles) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r, 3, 20), obstacleMat);
    m.position.set(o.x, 1.5, o.z);
    m.userData.tag = 'obstacle';
    obstacleGroup.add(m);
  }
}
rebuildObstacles(world);

// Player marker (visible in third-person debug only; first-person camera is the eyes)
const playerMesh = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.5, 1.0, 4, 12),
  new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.5 }),
);
playerMesh.userData.tag = 'player';
playerMesh.visible = false;
scene.add(playerMesh);

function syncCamera(w) {
  const p = w.player;
  camera.position.set(p.x, 1.7, p.z);
  camera.rotation.set(0, 0, 0);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = p.yaw;
  camera.rotation.x = p.pitch;
  playerMesh.position.set(p.x, 1.1, p.z);
}

installStudio({
  scene,
  seed: world.seed,
  onSeed: (w) => {
    rebuildObstacles(w);
    syncCamera(w);
  },
  afterStep: syncCamera,
  demos: {
    default(w) {
      w.paused = false;
    },
    freeze(w) {
      w.paused = true;
    },
    unfreeze(w) {
      w.paused = false;
    },
  },
});

// --- Input: WASD + mouse look (pointer lock) ---
const input = { forward: false, back: false, left: false, right: false, lookDX: 0, lookDY: 0 };
const KEYMAP = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right' };
addEventListener('keydown', (e) => {
  if (KEYMAP[e.code]) input[KEYMAP[e.code]] = true;
});
addEventListener('keyup', (e) => {
  if (KEYMAP[e.code]) input[KEYMAP[e.code]] = false;
});
renderer.domElement.addEventListener('click', () => renderer.domElement.requestPointerLock());
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) {
    input.lookDX += e.movementX * 0.0022;
    input.lookDY += e.movementY * 0.0022;
  }
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
  if (!w.paused) {
    stepWorld(w, dt, input);
    input.lookDX = 0;
    input.lookDY = 0;
  }
  syncCamera(w);
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    markReady();
  }
}
requestAnimationFrame(loop);
