import * as THREE from 'three';
import { createWorld, stepWorld, spawnBox } from './world.js';
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
camera.position.set(10, 9, 16);
camera.lookAt(0, 2, 0);

scene.add(new THREE.HemisphereLight(0x9db4ff, 0x1a2030, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(12, 24, 8);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.BoxGeometry(60, 10, 60),
  new THREE.MeshStandardMaterial({ color: 0x1c2a44, roughness: 0.9 }),
);
ground.position.y = -5;
ground.userData.tag = 'ground';
scene.add(ground);

const bodyMeshes = new Map();
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
function bodyColor(id) {
  const hue = (id * 47) % 360;
  return new THREE.Color(`hsl(${hue} 65% 55%)`);
}
function syncBodies(w) {
  const seen = new Set();
  for (const b of w.bodies) {
    if (b.isStatic) continue;
    seen.add(b.id);
    let m = bodyMeshes.get(b.id);
    if (!m) {
      m = new THREE.Mesh(
        boxGeo,
        new THREE.MeshStandardMaterial({ color: bodyColor(b.id), roughness: 0.6 }),
      );
      m.userData.tag = 'box';
      scene.add(m);
      bodyMeshes.set(b.id, m);
    }
    m.position.set(b.x, b.y, b.z);
    m.scale.set(b.hx * 2, b.hy * 2, b.hz * 2);
  }
  for (const [id, m] of bodyMeshes) {
    if (!seen.has(id)) {
      scene.remove(m);
      bodyMeshes.delete(id);
    }
  }
  hud(w);
}

const hudEl = document.getElementById('hud');
function hud(w) {
  hudEl.textContent =
    `physics-sandbox · bodies ${w.bodies.length - 1} · click the ground to spawn a box` +
    (w.bodies.length >= 120 ? ' · CAP 120' : '');
}

installStudio({
  scene,
  seed: world.seed,
  onSeed: (w) => {
    bodyMeshes.forEach((m) => scene.remove(m));
    bodyMeshes.clear();
    syncBodies(w);
  },
  afterStep: syncBodies,
  demos: {
    default(w) { w.paused = false; },
    freeze(w) { w.paused = true; },
    unfreeze(w) { w.paused = false; },
    // Harness API: spawn a box at a point (scripted interaction)
    spawnAt(w, x = 0, y = 8, z = 0) {
      spawnBox(w, x, y, z, 1);
      return true;
    },
  },
});

// Click to spawn: raycast onto the ground plane
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
renderer.domElement.addEventListener('click', (e) => {
  ptr.x = (e.clientX / innerWidth) * 2 - 1;
  ptr.y = -(e.clientY / innerHeight) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(ground)[0];
  const w = getWorld();
  if (hit && !w.paused) {
    spawnBox(w, hit.point.x, 8, hit.point.z, 0.8 + Math.random() * 0.8);
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
  if (!w.paused) stepWorld(w, dt, {});
  syncBodies(w);
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    markReady();
  }
}
syncBodies(world);
requestAnimationFrame(loop);
