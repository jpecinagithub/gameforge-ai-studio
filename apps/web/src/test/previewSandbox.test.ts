import { describe, expect, it } from 'vitest';
import { previewSandboxFor } from '../previewSandbox';

describe('previewSandboxFor', () => {
  it('allows storage only for a preview hosted on another origin', () => {
    expect(
      previewSandboxFor(
        'https://preview.example.com/b/build_ABC/',
        'https://studio.example.com',
      ),
    ).toBe('allow-scripts allow-same-origin');
  });

  it('keeps same-origin and invalid preview URLs opaque', () => {
    expect(
      previewSandboxFor('/preview/b/build_ABC/', 'https://studio.example.com'),
    ).toBe('allow-scripts');
    expect(previewSandboxFor('://invalid', 'https://studio.example.com')).toBe(
      'allow-scripts',
    );
  });
});
