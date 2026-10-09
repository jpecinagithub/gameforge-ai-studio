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

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200);
camera.position.set(6, 5, 8);
camera.lookAt(0, 1, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 1.2);
dir.position.set(5, 10, 4);
scene.add(dir);

const grid = new THREE.GridHelper(10, 10, 0x3b82f6, 0x1f2937);
grid.userData.tag = 'grid';
scene.add(grid);

const axes = new THREE.AxesHelper(3);
axes.userData.tag = 'axes';
axes.position.y = 0.01;
scene.add(axes);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1.4, 1.4, 1.4),
  new THREE.MeshStandardMaterial({ color: 0x8b5cf6, roughness: 0.35, metalness: 0.15 }),
);
cube.position.y = 1.2;
cube.userData.tag = 'cube';
scene.add(cube);

function syncMeshes(w) {
  cube.rotation.y = w.cube.angle;
}

function rebuildOnSeed(w) {
  // Static scene; nothing to rebuild. Dynamic objects would be rebuilt here.
  syncMeshes(w);
}

installStudio({
  scene,
  seed: world.seed,
  onSeed: rebuildOnSeed,
  afterStep: syncMeshes,
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
  syncMeshes(w);
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    markReady();
  }
}
requestAnimationFrame(loop);
