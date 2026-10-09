/**
 * Deterministic PRNG (mulberry32). The ONLY source of randomness in this
 * plugin — game logic and visual assets must reproduce exactly per seed.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Vec3 = [number, number, number];
export type Face = [number, number, number];

export interface Mesh {
  kind: string;
  seed: number;
  vertices: Vec3[];
  faces: Face[];
}

export type PrimitiveKind = 'box' | 'sphere' | 'plane' | 'terrain';

export interface GenerateOptions {
  kind: PrimitiveKind;
  seed: number;
  /** Edge length. Default 1. */
  size?: number;
  /** Subdivision detail. Clamped to 1..64. */
  detail?: number;
}

function clampDetail(detail: number | undefined, fallback: number): number {
  const d = Math.floor(detail ?? fallback);
  return Math.min(64, Math.max(1, d));
}

function box(size: number): Mesh {
  const h = size / 2;
  const vertices: Vec3[] = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  const faces: Face[] = [
    [0, 1, 2], [0, 2, 3],
    [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1],
    [2, 6, 7], [2, 7, 3],
    [0, 3, 7], [0, 7, 4],
    [1, 5, 6], [1, 6, 2],
  ];
  return { kind: 'box', seed: 0, vertices, faces };
}

function grid(n: number): { vertices: Vec3[]; faces: Face[] } {
  // n x n grid of quads on the XZ plane, y=0, spanning [-0.5, 0.5]^2.
  const vertices: Vec3[] = [];
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      vertices.push([ix / n - 0.5, 0, iz / n - 0.5]);
    }
  }
  const faces: Face[] = [];
  const idx = (ix: number, iz: number) => iz * (n + 1) + ix;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      faces.push([idx(ix, iz), idx(ix + 1, iz), idx(ix + 1, iz + 1)]);
      faces.push([idx(ix, iz), idx(ix + 1, iz + 1), idx(ix, iz + 1)]);
    }
  }
  return { vertices, faces };
}

function plane(size: number, detail: number): Mesh {
  const { vertices, faces } = grid(clampDetail(detail, 1));
  return {
    kind: 'plane',
    seed: 0,
    vertices: vertices.map(([x, y, z]) => [x * size, y, z * size]),
    faces,
  };
}

function sphere(size: number, detail: number, rand: () => number): Mesh {
  // Icosphere-ish: subdivided grid wrapped onto a sphere (cube-sphere
  // projection), deterministic; tiny seeded jitter keeps it "procedural".
  const n = clampDetail(detail, 8);
  const { vertices, faces } = grid(n);
  const r = size / 2;
  const out: Vec3[] = vertices.map(([x, , z]) => {
    const px = x * 2;
    const pz = z * 2;
    // Cube-sphere projection of the XZ face onto the sphere.
    const nx = px * Math.sqrt(Math.max(0, 1 - (pz * pz) / 2 - (px * px) / 2 + (px * px * pz * pz) / 3));
    const nz = pz * Math.sqrt(Math.max(0, 1 - (px * px) / 2 - (pz * pz) / 2 + (px * px * pz * pz) / 3));
    const ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz)) * (px + pz >= 0 ? 1 : -1);
    const jitter = 1 + (rand() - 0.5) * 0.06;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return [(nx / len) * r * jitter, (ny / len) * r * jitter, (nz / len) * r * jitter];
  });
  return { kind: 'sphere', seed: 0, vertices: out, faces };
}

function terrain(size: number, detail: number, rand: () => number): Mesh {
  // Heightfield: layered value noise from the seeded PRNG.
  const n = clampDetail(detail, 16);
  const { vertices, faces } = grid(n);
  const octaves = 4;
  const height = (u: number, v: number): number => {
    let h = 0;
    let amp = 1;
    let freq = 3;
    for (let o = 0; o < octaves; o++) {
      const cell = Math.floor(u * freq) + Math.floor(v * freq) * 997 + o * 131;
      const s = mulberry32(cell ^ 0x9e3779b9)();
      h += s * amp;
      amp *= 0.5;
      freq *= 2;
    }
    return h / 1.875 - 0.5; // normalize roughly to [-0.5, 0.5]
  };
  const jitter = (rand() - 0.5) * 0.02;
  const out: Vec3[] = vertices.map(([x, , z]) => {
    const u = x + 0.5;
    const v = z + 0.5;
    return [x * size, (height(u, v) + jitter) * size * 0.35, z * size];
  });
  return { kind: 'terrain', seed: 0, vertices: out, faces };
}

/** Generate a mesh deterministically from the spec. Throws on invalid input. */
export function generateMesh(opts: GenerateOptions): Mesh {
  if (!Number.isInteger(opts.seed)) {
    throw new Error('seed must be an integer');
  }
  const size = opts.size ?? 1;
  if (!Number.isFinite(size) || size <= 0 || size > 10_000) {
    throw new Error('size must be a positive finite number ≤ 10000');
  }
  const detail = clampDetail(opts.detail, 8);
  const rand = mulberry32(opts.seed);
  let mesh: Mesh;
  switch (opts.kind) {
    case 'box':
      mesh = box(size);
      break;
    case 'plane':
      mesh = plane(size, detail);
      break;
    case 'sphere':
      mesh = sphere(size, detail, rand);
      break;
    case 'terrain':
      mesh = terrain(size, detail, rand);
      break;
    default:
      throw new Error(`Unknown primitive kind "${(opts as { kind: string }).kind}"`);
  }
  mesh.seed = opts.seed;
  return mesh;
}
