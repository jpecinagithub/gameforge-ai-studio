import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  cancelRun,
  createProject,
  eventsUrl,
  listBuilds,
  listProjects,
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

describe('api client', () => {
  it('builds the projects URL with pagination params', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [], page: 2, pageSize: 10, total: 0 }),
    });
    const page = await listProjects(2, 10);
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v1/projects?page=2&pageSize=10');
    expect(page.total).toBe(0);
  });

  it('URL-encodes path params', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });
    await listBuilds('proj id/with?special');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/v1/projects/proj%20id%2Fwith%3Fspecial/builds');
  });

  it('POSTs JSON bodies for createProject', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: 'p1', name: 'X' }),
    });
    await createProject({ name: 'X', template: 'racing' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(String(init.body));
    expect(body.name).toBe('X');
    expect(body.template).toBe('racing');
  });

  it('parses the typed error envelope', async () => {
    mockFetchOnce({
      ok: false,
      status: 404,
      json: async () => ({
        error: { code: 'not_found', message: 'No such project', requestId: 'req-1' },
      }),
    });
    const err = await cancelRun('run_x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('not_found');
    expect((err as ApiError).message).toBe('No such project');
    expect((err as ApiError).requestId).toBe('req-1');
    expect((err as ApiError).status).toBe(404);
  });

  it('maps network failures to a typed ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('down')));
    const err = await listProjects().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('network_error');
    expect((err as ApiError).status).toBe(0);
  });

  it('eventsUrl appends lastEventId for replay', () => {
    expect(eventsUrl('run_1')).toContain('/api/v1/runs/run_1/events');
    expect(eventsUrl('run_1', '42')).toContain('lastEventId=42');
  });
});
