import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, downscale, encodePng, PngError } from '../src/png.js';
import { handleThumbnail, THUMB_MAX_DIM } from '../src/index.js';
import { makeToolCall } from '@gameforge/plugin-sdk';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('png codec', () => {
  it('decodes the real fixture PNG', async () => {
    const raw = await readFile(join(fixtures, 'gradient.png'));
    const img = decodePng(raw);
    expect(img.width).toBe(200);
    expect(img.height).toBe(100);
    // top-left pixel is dark, bottom-right is bright (independent of decoder)
    expect(img.pixels[0]).toBeLessThan(10);
    const last = (100 * 200 - 1) * 4;
    expect(img.pixels[last]).toBeGreaterThan(240);
    expect(img.pixels[last + 3]).toBe(255);
  });

  it('round-trips encode → decode', async () => {
    const raw = await readFile(join(fixtures, 'gradient.png'));
    const img = decodePng(raw);
    const re = decodePng(encodePng(img));
    expect(re.width).toBe(img.width);
    expect(re.height).toBe(img.height);
    expect(re.pixels).toEqual(img.pixels);
  });

  it('rejects non-PNG input honestly', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(PngError);
  });

  it('downscales to fit the max dimension', async () => {
    const raw = await readFile(join(fixtures, 'gradient.png'));
    const img = decodePng(raw);
    const small = downscale(img, THUMB_MAX_DIM);
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(THUMB_MAX_DIM);
    expect(small.width).toBe(128);
    expect(small.height).toBe(64);
  });
});

describe('handleThumbnail (tool protocol)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'thumb-test-'));
    await mkdir(join(root, 'assets', 'proj-1'), { recursive: true });
    await copyFile(
      join(fixtures, 'gradient.png'),
      join(root, 'assets', 'proj-1', 'gradient.png'),
    );
    await copyFile(
      join(fixtures, 'note.txt'),
      join(root, 'assets', 'proj-1', 'note.txt'),
    );
  });

  it('generates a real thumbnail for a stored PNG asset', async () => {
    const env = makeToolCall(
      'asset-thumbnail__thumbnail',
      't1',
      { storageRoot: root, projectId: 'proj-1', storedName: 'gradient.png' },
      { role: 'asset', projectId: 'proj-1' },
    );
    const res = await handleThumbnail(env);
    expect(res.ok).toBe(true);
    const out = res.output as { width: number; height: number; thumbnailPath: string };
    expect(out.width).toBe(128);
    expect(out.height).toBe(64);
    // The thumbnail file is a real, decodable PNG on disk.
    const bytes = await readFile(out.thumbnailPath);
    const img = decodePng(bytes);
    expect(img.width).toBe(128);
    expect(img.height).toBe(64);
  });

  it('returns unsupported_format for non-image assets — never a fake thumbnail', async () => {
    const env = makeToolCall(
      'asset-thumbnail__thumbnail',
      't2',
      { storageRoot: root, projectId: 'proj-1', storedName: 'note.txt' },
      { role: 'asset' },
    );
    const res = await handleThumbnail(env);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('unsupported_format');
  });

  it('returns a typed error for missing assets', async () => {
    const env = makeToolCall(
      'asset-thumbnail__thumbnail',
      't3',
      { storageRoot: root, projectId: 'proj-1', storedName: 'missing.png' },
      { role: 'asset' },
    );
    const res = await handleThumbnail(env);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('asset_not_found');
  });

  it('refuses path traversal', async () => {
    const env = makeToolCall(
      'asset-thumbnail__thumbnail',
      't4',
      { storageRoot: root, projectId: 'proj-1', storedName: '../../etc/passwd' },
      { role: 'asset' },
    );
    const res = await handleThumbnail(env);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('path_escape');
  });
});
