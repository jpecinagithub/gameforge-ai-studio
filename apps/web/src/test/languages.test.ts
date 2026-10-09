import { describe, expect, it } from 'vitest';
import { languageForPath } from '../api/languages';

describe('languageForPath', () => {
  const cases: Array<[string, string]> = [
    // Every extension used by the game templates.
    ['index.html', 'html'],
    ['src/main.js', 'javascript'],
    ['src/world.js', 'javascript'],
    ['src/studio.js', 'javascript'],
    ['studio.json', 'json'],
    ['README.md', 'markdown'],
    // Other common web extensions.
    ['app.ts', 'typescript'],
    ['comp.tsx', 'typescript'],
    ['lib.mjs', 'javascript'],
    ['lib.cjs', 'javascript'],
    ['old.htm', 'html'],
    ['styles.css', 'css'],
    ['theme.scss', 'scss'],
    ['data.jsonc', 'json'],
    ['notes.txt', 'plaintext'],
    ['config.yaml', 'yaml'],
    ['config.yml', 'yaml'],
    ['icon.svg', 'xml'],
    ['run.sh', 'shell'],
    // Case-insensitive.
    ['SRC/MAIN.JS', 'javascript'],
    ['Readme.MD', 'markdown'],
    // No extension / unknown → plaintext.
    ['Makefile', 'plaintext'],
    ['archive.xyz', 'plaintext'],
    ['.gitignore', 'plaintext'],
    ['dir.with.dots/file', 'plaintext'],
  ];
  for (const [path, expected] of cases) {
    it(`maps ${path} → ${expected}`, () => {
      expect(languageForPath(path)).toBe(expected);
    });
  }
});
