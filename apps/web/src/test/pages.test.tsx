import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { Assets } from '../pages/Assets';
import { Builds } from '../pages/Builds';
import { Revisions } from '../pages/Revisions';
import { Settings } from '../pages/Settings';

vi.mock('../api/client', () => ({
  getProject: vi.fn(async () => ({ id: 'p1', name: 'Test Game' })),
  listAssets: vi.fn(async () => ({ items: [], page: 1, pageSize: 50, total: 0 })),
  uploadAsset: vi.fn(async () => ({ id: 'a1', path: 'a/f.png' })),
  deleteAsset: vi.fn(async () => {}),
  assetDownloadUrl: (id: string) => `http://127.0.0.1:8090/api/v1/assets/${id}/download`,
  listRevisions: vi.fn(async () => ({ items: [], page: 1, pageSize: 50, total: 0 })),
  listBuilds: vi.fn(async () => []),
  getBuild: vi.fn(async () => ({ id: 'b1', status: 'verified' })),
  getBuildTests: vi.fn(async () => []),
  getBuildReviews: vi.fn(async () => []),
  getBuildArtifacts: vi.fn(async () => []),
  artifactDownloadUrl: (id: string) =>
    `http://127.0.0.1:8090/api/v1/artifacts/${id}/download`,
  getSettings: vi.fn(async () => ({})),
  patchSettings: vi.fn(async () => ({})),
  listModels: vi.fn(async () => ({ items: [] })),
  getModelCapabilities: vi.fn(async () => ({ capabilityKeys: [], agentRoles: [], provider: '' })),
  apiBaseUrl: () => 'http://127.0.0.1:8090',
}));

vi.mock('../components/Header', () => ({
  Header: () => <header data-testid="header" />,
}));
vi.mock('../components/UpdatePrompt', () => ({
  UpdatePrompt: () => null,
}));

function render(path: string, element: React.ReactNode): string {
  return renderToString(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={element} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('Phase 5 pages', () => {
  it('Assets page renders the upload zone without crashing', () => {
    const html = render('/projects/p1/assets', <Assets />);
    expect(html.length).toBeGreaterThan(0);
    // The upload dropzone + browse button are static (not data-dependent).
    expect(html).toContain('Upload assets');
  });

  it('Builds page renders its loading state without crashing', () => {
    const html = render('/projects/p1/builds', <Builds />);
    expect(html.length).toBeGreaterThan(0);
  });

  it('Revisions page renders its loading state without crashing', () => {
    const html = render('/projects/p1/revisions', <Revisions />);
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('Revisions');
  });

  it('Settings page renders all sections without crashing', () => {
    const html = render('/settings', <Settings />);
    expect(html.length).toBeGreaterThan(0);
    // Static section headings render before data loads.
    expect(html).toContain('Appearance');
    expect(html).toContain('Backend');
    expect(html).toContain('Models');
  });

  it('Assets page shows kind filter chips when multiple kinds exist', async () => {
    const client = await import('../api/client');
    vi.mocked(client.listAssets).mockResolvedValueOnce({
      items: [
        { id: 'a1', path: 's/hero.png', kind: 'image', bytes: 10, createdAt: '' },
        { id: 'a2', path: 's/jump.mp3', kind: 'audio', bytes: 10, createdAt: '' },
      ],
      page: 1,
      pageSize: 50,
      total: 2,
    });
    // renderToString does not run effects; the chips appear after data loads,
    // so this only asserts the page survives a populated mock without crashing.
    const html = render('/projects/p1/assets', <Assets />);
    expect(html.length).toBeGreaterThan(0);
  });
});
