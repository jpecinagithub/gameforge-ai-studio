import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { NewProjectDialog } from '../components/NewProjectDialog';

describe('NewProjectDialog', () => {
  it('asks only for the name and description', () => {
    const html = renderToString(
      <I18nextProvider i18n={i18n}>
        <NewProjectDialog
          open
          busy={false}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(html).toContain('Name');
    expect(html).toContain('Description');
    expect(html).not.toContain('Template');
    expect(html).not.toContain('Game kind');
    expect(html).not.toContain('<select');
  });
});
