/**
 * Map a file path to a Monaco editor language id.
 * Covers every extension used by the game templates
 * (index.html, src/*.js, studio.json, README.md, …).
 */

const EXTENSION_LANGUAGES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  txt: 'plaintext',
};

export function languageForPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  return EXTENSION_LANGUAGES[base.slice(dot + 1).toLowerCase()] ?? 'plaintext';
}
