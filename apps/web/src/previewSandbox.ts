const STRICT_PREVIEW_SANDBOX = 'allow-scripts';
const CROSS_ORIGIN_PREVIEW_SANDBOX = 'allow-scripts allow-same-origin';

/**
 * Generated games commonly use localStorage for scores and settings. An
 * opaque iframe origin blocks that API, so cross-origin previews retain their
 * own origin. If a deployment accidentally serves previews from the Studio
 * origin, keep the stricter sandbox: combining same-origin and scripts there
 * would allow generated content to escape the sandbox.
 */
export function previewSandboxFor(previewUrl: string, studioOrigin: string): string {
  try {
    const previewOrigin = new URL(previewUrl, studioOrigin).origin;
    return previewOrigin === studioOrigin
      ? STRICT_PREVIEW_SANDBOX
      : CROSS_ORIGIN_PREVIEW_SANDBOX;
  } catch {
    return STRICT_PREVIEW_SANDBOX;
  }
}
