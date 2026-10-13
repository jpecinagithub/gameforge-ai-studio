import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { autoRepairBuildFailure } from '../src/buildAutoRepair.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('autoRepairBuildFailure', () => {
  it('renames JSX-bearing .js entries and updates project references', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gf-auto-repair-'));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'main.js'), 'const App = () => <main />;');
    await fs.writeFile(path.join(dir, 'index.html'), '<script type="module" src="/src/main.js"></script>');

    const result = await autoRepairBuildFailure(
      dir,
      '[vite:build-import-analysis] Failed to parse source for import analysis because the content contains invalid JS syntax. If you are using JSX, name the file .jsx. file: /work/src/main.js:3:1',
    );

    expect(result).toMatchObject({ kind: 'jsx-extension', from: 'src/main.js', to: 'src/main.jsx' });
    await expect(fs.stat(path.join(dir, 'src', 'main.js'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, 'src', 'main.jsx'), 'utf8')).toContain('<main />');
    expect(await fs.readFile(path.join(dir, 'index.html'), 'utf8')).toContain('/src/main.jsx');
  });

  it('does nothing for unrelated failures', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gf-auto-repair-'));
    dirs.push(dir);
    expect(await autoRepairBuildFailure(dir, 'npm install failed')).toBeNull();
  });
});

