/**
 * Minimal runner service entrypoint.
 *
 * Phase 3 adds the HTTP binding so the orchestrator can call the runner
 * remotely. Until then this entrypoint is deliberately honest about what it is:
 *
 *   node dist/service.js --check   verify Docker is reachable, exit 0/1
 *   node dist/service.js           log a banner and idle (keeps the container
 *                                  up so the socket mount and volume
 *                                  permissions can be validated at deploy)
 */
import { dockerAvailable } from './index.js';

const mode = process.argv[2];

if (mode === '--check') {
  const ok = await dockerAvailable();
  console.log(ok ? 'docker: available' : 'docker: UNAVAILABLE');
  process.exit(ok ? 0 : 1);
}

console.log(
  [
    'gameforge-runner service: HTTP binding lands in Phase 3.',
    'This container exists so the Docker socket mount and volume permissions',
    'can be validated now. Validate with: docker compose exec runner node apps/runner/dist/service.js --check',
  ].join('\n'),
);
// Idle without busy-looping; SIGTERM from `docker compose down` ends us.
setInterval(() => {}, 1 << 30);
