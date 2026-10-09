import * as THREE from 'three';
import { createWorld, stepWorld, trackPointAt, TRACK_HALF_WIDTH } from './world.js';
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
scene.fog = new THREE.Fog(0x0b0e14, 80, 220);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 500);

scene.add(new THREE.HemisphereLight(0x9db4ff, 0x1a2030, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(40, 60, 20);
scene.add(sun);

// Track ribbon from centerline samples
const trackGroup = new THREE.Group();
scene.add(trackGroup);
function buildTrack(w) {
  trackGroup.clear();
  const { samples } = w.track;
  const shape = new THREE.Shape();
  const left = [];
  const right = [];
  for (let i = 0; i < samples.length; i += 2) {
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    // left normal
    left.push([a.x - dz * TRACK_HALF_WIDTH, a.z + dx * TRACK_HALF_WIDTH]);
    right.push([a.x + dz * TRACK_HALF_WIDTH, a.z - dx * TRACK_HALF_WIDTH]);
  }
  const pts = [...left, ...right.reverse()].map(([x, z]) => new THREE.Vector2(x, z));
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts));
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.95 }),
  );
  mesh.userData.tag = 'track';
  trackGroup.add(mesh);
  // start line
  const p0 = trackPointAt(w, 0);
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(TRACK_HALF_WIDTH * 2, 1.2),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  line.rotation.x = -Math.PI / 2;
  line.rotation.z = -p0.angle;
  line.position.set(p0.x, 0.02, p0.z);
  line.userData.tag = 'start-line';
  trackGroup.add(line);
  // ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x0f1a12, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.userData.tag = 'ground';
  trackGroup.add(ground);
}
buildTrack(world);

const car = new THREE.Mesh(
  new THREE.BoxGeometry(2.2, 0.9, 4.2),
  new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.4, metalness: 0.3 }),
);
car.userData.tag = 'car';
scene.add(car);
const carTop = new THREE.Mesh(
  new THREE.BoxGeometry(1.8, 0.7, 2.0),
  new THREE.MeshStandardMaterial({ color: 0x7f1d1d, roughness: 0.4 }),
);
carTop.position.y = 0.7;
car.add(carTop);

function syncScene(w) {
  const c = w.car;
  const p = trackPointAt(w, c.s);
  // lateral offset along normal
  const nx = -p.dirZ;
  const nz = p.dirX;
  car.position.set(p.x + nx * c.lat, 0.5, p.z + nz * c.lat);
  car.rotation.y = p.angle;
  // Chase camera
  const back = 11;
  const up = 5;
  camera.position.set(
    car.position.x - p.dirX * back,
    up,
    car.position.z - p.dirZ * back,
  );
  camera.lookAt(car.position.x, 1, car.position.z);
  hud(w);
}

const hudEl = document.getElementById('hud');
function hud(w) {
  const c = w.car;
  hudEl.innerHTML =
    `racing · lap ${c.lap} · speed ${c.speed.toFixed(1)} m/s` +
    (c.lastLapMs != null ? ` · last ${(c.lastLapMs / 1000).toFixed(2)}s` : '') +
    (c.bestLapMs != null ? ` · best ${(c.bestLapMs / 1000).toFixed(2)}s` : '') +
    (c.offTrack ? ' · <b>OFF TRACK</b>' : '');
}

installStudio({
  scene,
  seed: world.seed,
  onSeed: (w) => {
    buildTrack(w);
    syncScene(w);
  },
  afterStep: syncScene,
  demos: {
    default(w) { w.paused = false; },
    'start-line'(w) {
      w.car.s = 0; w.car.lat = 0; w.car.speed = 0;
      w.car.lapStartMs = w.timeMs; w.car.checkpoint = false;
    },
    freeze(w) { w.paused = true; },
    unfreeze(w) { w.paused = false; },
  },
});

const input = { throttle: 0, brake: 0, steer: 0 };
const keys = {};
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  applyKeys();
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  applyKeys();
});
function applyKeys() {
  input.throttle = keys.KeyW || keys.ArrowUp ? 1 : 0;
  input.brake = keys.KeyS || keys.ArrowDown ? 1 : 0;
  input.steer = (keys.KeyA || keys.ArrowLeft ? -1 : 0) + (keys.KeyD || keys.ArrowRight ? 1 : 0);
}
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
