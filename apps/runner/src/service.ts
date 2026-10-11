import http from 'node:http';
import { dockerAvailable, runJob } from './index.js';

const mode = process.argv[2];

if (mode === '--check') {
  const ok = await dockerAvailable();
  console.log(ok ? 'docker: available' : 'docker: UNAVAILABLE');
  process.exit(ok ? 0 : 1);
}

const port = Number(process.env.RUNNER_PORT ?? 8092);
const host = process.env.RUNNER_BIND_ADDR ?? '0.0.0.0';
const maxBodyBytes = 128 * 1024;
const maxConcurrent = Number(process.env.RUNNER_MAX_CONCURRENT ?? 4);
let active = 0;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > maxBodyBytes) throw new Error('request body too large');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const docker = await dockerAvailable();
    return send(res, docker ? 200 : 503, { ok: docker, docker, active, maxConcurrent });
  }
  if (req.method !== 'POST' || req.url !== '/v1/jobs') {
    return send(res, 404, { error: 'not_found' });
  }
  if (active >= maxConcurrent) {
    return send(res, 503, { error: 'runner_busy' });
  }

  active += 1;
  try {
    const result = await runJob(await readJson(req));
    return send(res, 200, result);
  } catch (err) {
    const e = err as Error & { code?: string };
    const status = e.code === 'invalid_spec' || e.code === 'image_not_allowed' ? 400 : 500;
    return send(res, status, {
      error: e.code ?? 'runner_error',
      message: e.message || 'runner job failed',
    });
  } finally {
    active -= 1;
  }
});

server.listen(port, host, () => {
  console.log(`[runner] listening on http://${host}:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
