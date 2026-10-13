import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface BuildAutoRepairResult {
  kind: 'jsx-extension';
  from: string;
  to: string;
  updatedReferences: string[];
}

const TEXT_EXTENSIONS = new Set([
  '.html', '.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.md', '.mjs', '.cjs', '.webmanifest',
]);

function posix(value: string): string {
  return value.split(path.sep).join('/');
}

async function textFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
    }
  };
  await walk(root);
  return files;
}

/**
 * Repair diagnostics that are completely mechanical and safe to resolve
 * without another model round. Source changes remain in the project tree and
 * are checkpointed by the orchestrator before the next build.
 */
export async function autoRepairBuildFailure(
  workDir: string,
  diagnostics: string | null,
): Promise<BuildAutoRepairResult | null> {
  if (!diagnostics || !/invalid JS syntax/i.test(diagnostics) || !/using JSX/i.test(diagnostics)) return null;

  const match = /file:\s+\/work\/([A-Za-z0-9_./-]+\.js)(?:[:\s(])/.exec(diagnostics)
    ?? /(?:^|[\s"\\])([A-Za-z0-9_./-]+\.js)\s+\(\d+:\d+\)/m.exec(diagnostics);
  const from = match?.[1];
  if (!from) return null;

  const normalizedFrom = posix(path.normalize(from));
  if (normalizedFrom.startsWith('../') || path.isAbsolute(from)) return null;
  const to = normalizedFrom.replace(/\.js$/, '.jsx');
  const source = path.resolve(workDir, normalizedFrom);
  const destination = path.resolve(workDir, to);
  const root = path.resolve(workDir);
  if (!source.startsWith(`${root}${path.sep}`) || !destination.startsWith(`${root}${path.sep}`)) return null;

  try {
    await fs.stat(source);
  } catch {
    return null;
  }
  try {
    await fs.stat(destination);
    return null;
  } catch {
    // Expected: destination must not already exist.
  }

  await fs.rename(source, destination);
  const updatedReferences: string[] = [];
  for (const absolute of await textFiles(workDir)) {
    const rel = posix(path.relative(workDir, absolute));
    let content = await fs.readFile(absolute, 'utf8');
    const before = content;
    content = content.replaceAll(normalizedFrom, to);

    const ownerDir = path.posix.dirname(rel);
    let relativeFrom = path.posix.relative(ownerDir, normalizedFrom);
    let relativeTo = path.posix.relative(ownerDir, to);
    if (!relativeFrom.startsWith('.')) relativeFrom = `./${relativeFrom}`;
    if (!relativeTo.startsWith('.')) relativeTo = `./${relativeTo}`;
    content = content.replaceAll(relativeFrom, relativeTo);

    if (content !== before) {
      await fs.writeFile(absolute, content, 'utf8');
      updatedReferences.push(rel);
    }
  }

  return { kind: 'jsx-extension', from: normalizedFrom, to, updatedReferences };
}

