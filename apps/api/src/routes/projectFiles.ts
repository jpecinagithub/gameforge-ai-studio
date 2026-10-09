import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, sep, dirname, relative } from 'node:path';
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { paginationSchema, page } from '@gameforge/shared';
import { badRequest, binaryFile, conflict, notFound, payloadTooLarge } from '../httpErrors.js';
import { parseOr400, requireProject, assertUuid } from './routeUtil.js';
import '../types.js';

const execFileAsync = promisify(execFile);

const GIT_AUTHOR = ['-c', 'user.name=GameForge Studio', '-c', 'user.email=studio@local'];
const MAX_READ_BYTES = 1024 * 1024; // 1 MiB
const MAX_WRITE_BYTES = 2 * 1024 * 1024; // 2 MiB
const EXCLUDED_DIRS = new Set(['.git', '.studio', 'node_modules']);

const writeFileSchema = z.object({
  content: z.string().max(MAX_WRITE_BYTES),
  expectedSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/i, 'expectedSha must be a 40-char git blob sha')
    .optional(),
});

/** Resolve a user-supplied relative path inside the repo; null on escape. */
function resolveInRepo(repoDir: string, rel: string): string | null {
  const normalized = rel.replace(/\\/g, '/');
  const abs = resolve(repoDir, normalized);
  const root = resolve(repoDir);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

async function git(args: string[], cwd: string, timeoutMs = 30000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: timeoutMs });
  return stdout.trim();
}

async function blobSha(repoDir: string, rel: string): Promise<string | null> {
  try {
    return await git(['hash-object', rel], repoDir);
  } catch {
    return null;
  }
}

/** Null-byte sniff on the first chunk: cheap binary detection. */
function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  return head.includes(0);
}

interface FileEntry {
  path: string;
  size: number;
  modifiedAt: string;
}

async function listFilesRecursive(repoDir: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string, rel: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') && rel === '' && EXCLUDED_DIRS.has(e.name)) continue;
      if (EXCLUDED_DIRS.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, childRel);
      } else if (e.isFile()) {
        const st = await stat(abs);
        out.push({
          path: childRel,
          size: st.size,
          modifiedAt: st.mtime.toISOString(),
        });
      }
    }
  }
  await walk(repoDir, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export async function projectFileRoutes(fastify: FastifyInstance): Promise<void> {
  const { db, storageRoot } = fastify.gameforge;
  const repoDir = (id: string) => join(storageRoot, 'projects', id, 'repo');

  async function requireRepo(projectId: string): Promise<string> {
    await requireProject(db, projectId);
    const dir = repoDir(projectId);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) throw notFound('project repository');
    } catch {
      throw notFound('project repository');
    }
    return dir;
  }

  fastify.get('/projects/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    assertUuid(id, 'project');
    const dir = await requireRepo(id);
    return { files: await listFilesRecursive(dir) };
  });

  fastify.get('/projects/:id/files/*', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rel = (req.params as { '*': string })['*'] ?? '';
    assertUuid(id, 'project');
    const dir = await requireRepo(id);
    const abs = resolveInRepo(dir, rel);
    if (!abs) throw notFound('file');
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw notFound('file');
    }
    if (!st.isFile()) throw notFound('file');
    if (st.size > MAX_READ_BYTES) {
      throw payloadTooLarge(`File is larger than ${MAX_READ_BYTES} bytes`, {
        path: rel,
        size: st.size,
      });
    }
    const buf = await readFile(abs);
    if (looksBinary(buf)) {
      throw binaryFile('File is binary; text preview is not available', { path: rel });
    }
    const sha = await blobSha(dir, relative(dir, abs));
    return reply.send({ path: rel, content: buf.toString('utf8'), sha });
  });

  fastify.put('/projects/:id/files/*', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rel = (req.params as { '*': string })['*'] ?? '';
    assertUuid(id, 'project');
    if (!rel || rel.endsWith('/')) throw badRequest('A file path is required');
    const body = parseOr400(writeFileSchema, req.body);
    const dir = await requireRepo(id);
    const abs = resolveInRepo(dir, rel);
    if (!abs) throw notFound('file');

    const currentSha = await blobSha(dir, rel);
    if (body.expectedSha !== undefined && body.expectedSha.toLowerCase() !== (currentSha ?? '').toLowerCase()) {
      throw conflict('File changed since you last read it; reload before saving', {
        path: rel,
        currentSha,
      });
    }

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body.content, 'utf8');
    const relPosix = relative(dir, abs).split(sep).join('/');
    await git(['add', relPosix], dir);
    await git([...GIT_AUTHOR, 'commit', '-m', `studio: update ${relPosix}`], dir);
    const sha = await blobSha(dir, relPosix);
    const commitSha = await git(['rev-parse', 'HEAD'], dir);
    return reply.send({ path: relPosix, sha, commitSha });
  });

  fastify.get('/projects/:id/revisions', async (req) => {
    const { id } = req.params as { id: string };
    assertUuid(id, 'project');
    await requireProject(db, id);
    const { page: p, pageSize: ps } = parseOr400(paginationSchema, req.query);
    const offset = (p - 1) * ps;
    const [{ rows: countRows }, { rows }] = await Promise.all([
      db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM project_revisions WHERE project_id = $1`,
        [id],
      ),
      db.query(
        `SELECT id, git_sha, message, author_kind, checkpoint_kind, healthy, created_at
           FROM project_revisions WHERE project_id = $1
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [id, ps, offset],
      ),
    ]);
    return page(
      rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          id: row.id,
          sha: row.git_sha,
          message: row.message,
          author: row.author_kind,
          checkpointKind: row.checkpoint_kind,
          healthy: row.healthy,
          createdAt: row.created_at,
        };
      }),
      Number(countRows[0]?.total ?? 0),
      p,
      ps,
    );
  });
}
