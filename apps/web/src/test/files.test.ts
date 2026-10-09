import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { ConflictError, getFile, listFiles, saveFile } from '../api/files';

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

describe('project files client', () => {
  it('lists files from the project files endpoint', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        files: [{ path: 'index.html', size: 120, modifiedAt: '2026-10-09T00:00:00Z' }],
      }),
    });
    const files = await listFiles('proj-1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/projects/proj-1/files');
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('index.html');
  });

  it('URL-encodes each path segment', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ path: 'src/main file.js', content: 'x', sha: 's1' }),
    });
    await getFile('p1', 'src/main file.js');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v1/projects/p1/files/src/main%20file.js');
    // The slash separator itself must not be encoded.
    expect(url).not.toContain('src%2Fmain');
  });

  it('maps a 409 to ConflictError carrying the server currentSha', async () => {
    mockFetchOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'conflict' }, currentSha: 'sha999' }),
    });
    const err = await saveFile('p1', 'a.js', 'new', 'sha1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).currentSha).toBe('sha999');
  });

  it('maps a 409 without currentSha to an empty currentSha', async () => {
    mockFetchOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'conflict' } }),
    });
    const err = await saveFile('p1', 'a.js', 'new', 'sha1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).currentSha).toBe('');
  });

  it('surfaces binary_file as an ApiError with that code', async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'binary_file' } }),
    });
    const err = await getFile('p1', 'sprite.png').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('binary_file');
  });

  it('sends expectedSha only when provided', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ path: 'a.js', sha: 's2', commitSha: 'c1' }),
    });
    await saveFile('p1', 'a.js', 'content', 's1');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toEqual({ content: 'content', expectedSha: 's1' });

    fetchMock.mockClear();
    await saveFile('p1', 'a.js', 'content');
    const body2 = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body2).toEqual({ content: 'content' });
    expect('expectedSha' in body2).toBe(false);
  });

  it('PUTs to the file path endpoint and returns sha + commitSha', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ path: 'a.js', sha: 's2', commitSha: 'c1' }),
    });
    const res = await saveFile('p1', 'a.js', 'content', 's1');
    expect(res.sha).toBe('s2');
    expect(res.commitSha).toBe('c1');
  });
});
