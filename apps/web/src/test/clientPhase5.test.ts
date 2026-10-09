import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactDownloadUrl,
  assetDownloadUrl,
  deleteAsset,
  getBuild,
  getBuildArtifacts,
  getBuildReviews,
  getBuildTests,
  getModelCapabilities,
  getSettings,
  listAssets,
  listModels,
  listRevisions,
  patchSettings,
  uploadAsset,
} from '../api/client';

function mockFetchOnce(response: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Phase 5 client functions', () => {
  it('listAssets builds the paginated URL and returns the page', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: 'a1',
            path: 'sprites/hero.png',
            kind: 'image',
            bytes: 1024,
            useStage: 'unconfirmed',
            createdAt: '2026-10-09T00:00:00Z',
          },
        ],
        page: 1,
        pageSize: 50,
        total: 1,
      }),
    });
    const page = await listAssets('proj-1');
    expect(page.total).toBe(1);
    expect(page.items[0]!.path).toBe('sprites/hero.png');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/api/v1/projects/proj-1/assets?page=1&pageSize=50');
  });

  it('getBuild fetches a single build', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'build_1', status: 'verified' }),
    });
    const b = await getBuild('build_1');
    expect(b.id).toBe('build_1');
    expect(b.status).toBe('verified');
  });

  it('getSettings returns the settings map', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ modelByRole: { director: 'm1' }, language: 'en' }),
    });
    const s = await getSettings();
    expect((s['modelByRole'] as Record<string, string>)['director']).toBe('m1');
  });

  it('patchSettings sends a PATCH with the JSON body', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ modelByRole: { director: 'm2' } }),
    });
    const s = await patchSettings({ modelByRole: { director: 'm2' } });
    expect((s['modelByRole'] as Record<string, string>)['director']).toBe('m2');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ modelByRole: { director: 'm2' } });
  });

  it('listModels and getModelCapabilities hit the right endpoints', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ modelId: 'm1', displayName: 'M1' }] }),
    });
    const models = await listModels();
    expect(models.items[0]!.modelId).toBe('m1');
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/api/v1/models');

    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        capabilityKeys: ['supports_tools'],
        agentRoles: ['director', 'reviewer'],
        provider: 'groq',
      }),
    });
    const caps = await getModelCapabilities();
    expect(caps.agentRoles).toContain('reviewer');
    expect(caps.provider).toBe('groq');
  });
});

describe('Phase 5 reconciliation client functions', () => {
  it('listRevisions builds the paginated URL and returns the page', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: 'r1',
            sha: 'abc123',
            message: 'build b1 verified',
            author: 'system',
            checkpointKind: 'land',
            healthy: true,
            createdAt: '2026-10-09T00:00:00Z',
          },
        ],
        page: 2,
        pageSize: 50,
        total: 51,
      }),
    });
    const page = await listRevisions('proj-1', 2);
    expect(page.total).toBe(51);
    expect(page.items[0]!.healthy).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/api/v1/projects/proj-1/revisions?page=2&pageSize=50');
  });

  it('uploadAsset POSTs multipart with the file and optional kind', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'a1',
        path: 'proj-1/a1_hero.png',
        kind: 'image',
        url: '/api/v1/assets/a1/download',
      }),
    });
    const file = new File(['bytes'], 'hero.png', { type: 'image/png' });
    const asset = await uploadAsset('proj-1', file, 'image');
    expect(asset.id).toBe('a1');
    expect(asset.kind).toBe('image');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/projects/proj-1/assets?kind=image');
    expect(init.method).toBe('POST');
    const body = init.body as FormData;
    const attached = body.get('file') as File | null;
    expect(attached).not.toBeNull();
    expect(attached!.name).toBe('hero.png');
    // multipart: no JSON content-type forced
    const headers = init.headers as Record<string, string>;
    expect(headers?.['Content-Type']).toBeUndefined();
  });

  it('uploadAsset omits the kind query when auto-detecting', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'a2' }),
    });
    const file = new File(['x'], 'sfx.mp3');
    await uploadAsset('proj-1', file);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/api/v1/projects/proj-1/assets');
    expect(url).not.toContain('?kind=');
  });

  it('uploadAsset surfaces a 413 payload_too_large error', async () => {
    mockFetchOnce({
      ok: false,
      status: 413,
      json: async () => ({
        error: { code: 'payload_too_large', message: 'too large', requestId: 'r' },
      }),
    });
    const file = new File(['x'], 'big.bin');
    await expect(uploadAsset('proj-1', file)).rejects.toMatchObject({
      code: 'payload_too_large',
    });
  });

  it('deleteAsset sends DELETE and resolves on 204', async () => {
    const fetchMock = mockFetchOnce({ ok: true, status: 204, json: async () => undefined });
    await deleteAsset('a1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/assets/a1');
    expect(init.method).toBe('DELETE');
  });

  it('getBuildTests / getBuildReviews / getBuildArtifacts hit their endpoints', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [{ suite: 's', name: 'n', status: 'pass' }],
    });
    const tests = await getBuildTests('b1');
    expect(tests[0]!.status).toBe('pass');
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/api/v1/builds/b1/tests');

    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [{ criterion: 'c', result: 'pass' }],
    });
    const reviews = await getBuildReviews('b1');
    expect(reviews[0]!.criterion).toBe('c');

    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 'ar1', kind: 'dist', name: 'game.zip', url: '/api/v1/artifacts/ar1/download' }],
    });
    const artifacts = await getBuildArtifacts('b1');
    expect(artifacts[0]!.name).toBe('game.zip');
  });

  it('download URL helpers point at the real endpoints', () => {
    expect(assetDownloadUrl('a1')).toContain('/api/v1/assets/a1/download');
    expect(artifactDownloadUrl('ar1')).toContain('/api/v1/artifacts/ar1/download');
  });
});
