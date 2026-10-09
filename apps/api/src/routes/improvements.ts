/**
 * Self-improvement proposals (§6) — evidence-gated, versioned, auto-apply OFF.
 *
 * Lifecycle: proposed → approved → applied → (prompt scope: candidate in
 * skill_versions) → activate (prompt only, needs held-out gate evidence).
 * Any step can end in rejected; applied config/prompt changes can be rolled
 * back. Every mutation is written to audit_events with the actor identity.
 *
 * TRUST MODEL (adapted-from-Genex: agents can never install/enable plugins):
 * agents act exclusively through the in-process agent toolset
 * (readFile/writeFile/execBuild/...) and have NO HTTP tool to reach these
 * routes — the API is the human/API-key surface (private boundary, §9).
 * Defense in depth: every mutating endpoint requires an X-Studio-Actor
 * header; `agent:*` identities are explicitly rejected on
 * approve/reject/apply/activate/rollback (403), and only recorded as
 * `proposed_by` on propose.
 *
 * Apply semantics are honest per scope:
 * - prompt: stages a CANDIDATE row in skill_versions (never activates).
 * - config: writes application_settings (rollbackable; secret-like keys and
 *   secret-looking values are refused, same rule as PATCH /settings).
 * - code: stores the unified diff for MANUAL review. Untrusted code is never
 *   executed and never written into the repo by apply.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ApiErrorCode,
  ImprovementScope,
  ImprovementStatus,
  activateImprovementSchema,
  globalRedactor,
  paginationSchema,
  page,
  proposeImprovementSchema,
} from '@gameforge/shared';
import { HttpError, badRequest, conflict, notFound } from '../httpErrors.js';
import { parseOr400, assertUuid } from './routeUtil.js';
import type { DbClient } from '../db.js';
import '../types.js';

const ACTOR_HEADER = 'x-studio-actor';
const SECRET_LIKE = /key|token|secret|password|passwd|credential|dsn/i;
const SECRET_VALUE = /^(gsk_|sk-|-----BEGIN)/;

const forbidden = (message: string, detail?: Record<string, unknown>) =>
  new HttpError(403, ApiErrorCode.FORBIDDEN, message, detail);

interface Actor {
  raw: string;
  kind: 'user' | 'apikey' | 'system' | 'agent' | 'other';
}

/** Require the actor header; never throw on a missing/malformed value — 403 it. */
function actorOf(req: FastifyRequest): Actor {
  const raw = String(req.headers[ACTOR_HEADER] ?? '').trim();
  if (!raw) throw forbidden('X-Studio-Actor header is required for this action');
  const kind = raw.startsWith('user:')
    ? 'user'
    : raw.startsWith('apikey:')
      ? 'apikey'
      : raw.startsWith('system:')
        ? 'system'
        : raw.startsWith('agent:')
          ? 'agent'
          : 'other';
  return { raw: raw.slice(0, 200), kind };
}

/** Approve-class actions are human/API-key only — agents can NEVER approve. */
function requireHuman(actor: Actor, action: string): void {
  if (actor.kind === 'agent') {
    throw forbidden(
      `agents cannot ${action} improvement proposals — approval is human/API-key only`,
      { action },
    );
  }
  if (actor.kind !== 'user' && actor.kind !== 'apikey') {
    throw forbidden(`unrecognized actor identity for ${action}; use user: or apikey:`, {
      action,
    });
  }
}

async function audit(
  db: DbClient,
  actor: string,
  action: string,
  target: string,
  details: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (actor, action, target, details)
     VALUES ($1, $2, $3, $4)`,
    [actor, action, target, JSON.stringify(globalRedactor.redactDeep(details))],
  );
}

interface ProposalRow {
  id: string;
  version: number;
  title: string;
  scope: string;
  target: string;
  change: unknown;
  evidence: unknown;
  status: string;
  proposed_by: string;
  approved_by: string | null;
  approved_at: string | null;
  applied_at: string | null;
  previous_state: unknown;
  outcome: unknown;
  created_at: string;
  updated_at: string;
}

function toProposalJson(p: ProposalRow) {
  return {
    id: p.id,
    version: p.version,
    title: p.title,
    scope: p.scope,
    target: p.target,
    change: p.change,
    evidence: p.evidence,
    status: p.status,
    proposedBy: p.proposed_by,
    approvedBy: p.approved_by,
    approvedAt: p.approved_at,
    appliedAt: p.applied_at,
    previousState: p.previous_state,
    outcome: p.outcome,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

async function requireProposal(db: DbClient, id: string): Promise<ProposalRow> {
  assertUuid(id, 'proposal');
  const { rows } = await db.query<ProposalRow>(
    `SELECT * FROM improvement_proposals WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) throw notFound('improvement proposal');
  return rows[0] as ProposalRow;
}

/** Evidence refs must name REAL records — validated at propose/activate time. */
async function validateEvidence(
  db: DbClient,
  evidence: Array<{ kind: string; id: string }>,
): Promise<void> {
  for (const e of evidence) {
    if (e.kind === 'build') {
      const { rows } = await db.query(`SELECT 1 FROM build_jobs WHERE id = $1`, [e.id]);
      if (rows.length === 0) {
        throw badRequest(`evidence references unknown build '${e.id}'`, { evidence: e });
      }
    } else if (e.kind === 'review') {
      let rows: unknown[] = [];
      try {
        const r = await db.query(`SELECT 1 FROM review_results WHERE id = $1::uuid`, [e.id]);
        rows = r.rows;
      } catch {
        rows = []; // malformed uuid → invalid reference, not a 500
      }
      if (rows.length === 0) {
        throw badRequest(`evidence references unknown review '${e.id}'`, { evidence: e });
      }
    } else {
      throw badRequest(`unknown evidence kind '${e.kind}'`, { evidence: e });
    }
  }
}

/** Scope-bounded change validation. Returns the normalized change payload. */
function validateChange(
  scope: string,
  target: string,
  change: Record<string, unknown>,
): Record<string, unknown> {
  if (scope === ImprovementScope.PROMPT) {
    if (/[\\/]/.test(target) || target.length > 120) {
      throw badRequest('prompt target must be a prompt/skill name, not a path', { target });
    }
    const content = change.content;
    if (typeof content !== 'string' || content.length < 1 || content.length > 50000) {
      throw badRequest('prompt change requires { content: string(1..50000) }');
    }
    return { content };
  }
  if (scope === ImprovementScope.CONFIG) {
    if (target.length > 120) throw badRequest('config target key too long');
    if (SECRET_LIKE.test(target)) {
      throw badRequest(
        `Refusing secret-like setting '${target}'; secrets live in the server vault`,
      );
    }
    if (!('value' in change)) throw badRequest('config change requires { value }');
    const value = change.value;
    if (typeof value === 'string' && SECRET_VALUE.test(value)) {
      throw badRequest('Refusing secret-looking config value; secrets live in the server vault');
    }
    return { value };
  }
  if (scope === ImprovementScope.CODE) {
    if (
      target.startsWith('/') ||
      target.includes('\\') ||
      /(^|\/)\.\.(\/|$)/.test(target) ||
      target.startsWith('.') ||
      target.length > 512
    ) {
      throw badRequest('code target must be a safe repo-relative path', { target });
    }
    const diff = change.diff;
    if (typeof diff !== 'string' || diff.length < 1 || diff.length > 200000) {
      throw badRequest('code change requires { diff: string(1..200000) } (unified diff)');
    }
    return { diff };
  }
  throw badRequest(`unknown scope '${scope}'`);
}

export async function improvementRoutes(fastify: FastifyInstance): Promise<void> {
  const { db } = fastify.gameforge;

  fastify.get('/improvements', async (req) => {
    const { page: pg, pageSize } = parseOr400(paginationSchema, req.query);
    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.query<ProposalRow>(
        `SELECT * FROM improvement_proposals ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [pageSize, (pg - 1) * pageSize],
      ),
      db.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM improvement_proposals`),
    ]);
    return page(
      (rows as ProposalRow[]).map(toProposalJson),
      Number(countRows[0]?.total ?? 0),
      pg,
      pageSize,
    );
  });

  fastify.get('/improvements/:id', async (req) => {
    const { id } = req.params as { id: string };
    const proposal = await requireProposal(db, id);
    const { rows } = await db.query(
      `SELECT version, change, evidence, created_by, created_at
         FROM improvement_proposal_versions WHERE proposal_id = $1 ORDER BY version`,
      [id],
    );
    return { ...toProposalJson(proposal), versions: rows };
  });

  fastify.post('/improvements', async (req) => {
    const actor = actorOf(req);
    const body = parseOr400(proposeImprovementSchema, req.body) as {
      title: string;
      scope: string;
      target: string;
      change: Record<string, unknown>;
      evidence: Array<{ kind: string; id: string }>;
    };
    await validateEvidence(db, body.evidence);
    const change = validateChange(body.scope, body.target, body.change);
    const { rows } = await db.query<ProposalRow>(
      `INSERT INTO improvement_proposals
         (title, scope, target, change, evidence, status, proposed_by)
       VALUES ($1, $2, $3, $4, $5, 'proposed', $6)
       RETURNING *`,
      [
        body.title,
        body.scope,
        body.target,
        JSON.stringify(change),
        JSON.stringify(body.evidence),
        actor.raw,
      ],
    );
    const proposal = rows[0] as ProposalRow;
    await db.query(
      `INSERT INTO improvement_proposal_versions
         (proposal_id, version, change, evidence, created_by)
       VALUES ($1, 1, $2, $3, $4)`,
      [proposal.id, JSON.stringify(change), JSON.stringify(body.evidence), actor.raw],
    );
    await audit(db, actor.raw, 'improvement.propose', proposal.id, {
      title: body.title,
      scope: body.scope,
    });
    return toProposalJson(proposal);
  });

  fastify.post('/improvements/:id/approve', async (req) => {
    const actor = actorOf(req);
    requireHuman(actor, 'approve');
    const { id } = req.params as { id: string };
    const proposal = await requireProposal(db, id);
    if (proposal.status !== ImprovementStatus.PROPOSED) {
      throw conflict(`cannot approve a proposal in status '${proposal.status}'`);
    }
    const { rows } = await db.query<ProposalRow>(
      `UPDATE improvement_proposals
         SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, actor.raw],
    );
    await audit(db, actor.raw, 'improvement.approve', id, { title: proposal.title });
    return toProposalJson(rows[0] as ProposalRow);
  });

  fastify.post('/improvements/:id/reject', async (req) => {
    const actor = actorOf(req);
    requireHuman(actor, 'reject');
    const { id } = req.params as { id: string };
    const proposal = await requireProposal(db, id);
    if (
      proposal.status !== ImprovementStatus.PROPOSED &&
      proposal.status !== ImprovementStatus.APPROVED
    ) {
      throw conflict(`cannot reject a proposal in status '${proposal.status}'`);
    }
    const { rows } = await db.query<ProposalRow>(
      `UPDATE improvement_proposals
         SET status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    await audit(db, actor.raw, 'improvement.reject', id, { title: proposal.title });
    return toProposalJson(rows[0] as ProposalRow);
  });

  fastify.post('/improvements/:id/apply', async (req) => {
    const actor = actorOf(req);
    requireHuman(actor, 'apply');
    const { id } = req.params as { id: string };
    const proposal = await requireProposal(db, id);
    if (proposal.status !== ImprovementStatus.APPROVED) {
      // Auto-apply is OFF: apply without a prior human approval is rejected.
      throw conflict(
        `cannot apply a proposal in status '${proposal.status}' — approval is required first`,
      );
    }
    const change = proposal.change as Record<string, unknown>;
    let previousState: Record<string, unknown> = {};
    let outcome: Record<string, unknown> = {};

    if (proposal.scope === ImprovementScope.PROMPT) {
      // Stage a CANDIDATE — activation is a separate explicit human step.
      const { rows: vrows } = await db.query<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM skill_versions WHERE skill_name = $1`,
        [proposal.target],
      );
      const version = Number((vrows[0] as { v: number }).v);
      const { rows: arows } = await db.query<{ version: number }>(
        `SELECT version FROM skill_versions WHERE skill_name = $1 AND status = 'active'`,
        [proposal.target],
      );
      previousState = { activeVersion: arows.length > 0 ? arows[0].version : null };
      await db.query(
        `INSERT INTO skill_versions (skill_name, version, content, status, evidence)
         VALUES ($1, $2, $3, 'candidate', $4)`,
        [
          proposal.target,
          version,
          String(change.content),
          JSON.stringify({ proposalId: id, evidence: proposal.evidence }),
        ],
      );
      outcome = { staged: 'candidate', skillName: proposal.target, version };
    } else if (proposal.scope === ImprovementScope.CONFIG) {
      const { rows: srows } = await db.query<{ value: unknown }>(
        `SELECT value FROM application_settings WHERE key = $1`,
        [proposal.target],
      );
      previousState = { value: srows.length > 0 ? srows[0].value : null, existed: srows.length > 0 };
      await db.query(
        `INSERT INTO application_settings (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [proposal.target, JSON.stringify(change.value)],
      );
      outcome = { applied: true, key: proposal.target };
    } else {
      // CODE: the diff is stored, versioned, for manual review. Untrusted
      // code is never executed and never written into the repo by apply.
      previousState = { staged: false };
      outcome = {
        staged: 'manual-review',
        note: 'unified diff stored in the proposal record for manual review; apply never executes or writes code',
      };
    }

    const { rows } = await db.query<ProposalRow>(
      `UPDATE improvement_proposals
         SET status = 'applied', applied_at = now(), previous_state = $2, outcome = $3,
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(previousState), JSON.stringify(outcome)],
    );
    await audit(db, actor.raw, 'improvement.apply', id, {
      scope: proposal.scope,
      outcome,
    });
    return toProposalJson(rows[0] as ProposalRow);
  });

  fastify.post('/improvements/:id/activate', async (req) => {
    const actor = actorOf(req);
    requireHuman(actor, 'activate');
    const { id } = req.params as { id: string };
    const proposal = await requireProposal(db, id);
    if (proposal.scope !== ImprovementScope.PROMPT) {
      throw badRequest('activate is only meaningful for prompt-scope proposals');
    }
    if (proposal.status !== ImprovementStatus.APPLIED) {
      throw conflict(`cannot activate a proposal in status '${proposal.status}'`);
    }
    const body = parseOr400(activateImprovementSchema, req.body) as {
      gateEvidence: Array<{ kind: string; id: string }>;
    };
    await validateEvidence(db, body.gateEvidence);
    const outcome = (proposal.outcome ?? {}) as Record<string, unknown>;
    const version = Number(outcome.version ?? 0);
    if (!version) throw badRequest('proposal has no staged candidate version to activate');

    // Promote the candidate; roll back any previously active version.
    await db.query(
      `UPDATE skill_versions SET status = 'rolled_back'
       WHERE skill_name = $1 AND status = 'active'`,
      [proposal.target],
    );
    const { rows: urows } = await db.query(
      `UPDATE skill_versions SET status = 'active'
       WHERE skill_name = $1 AND version = $2 AND status = 'candidate'
       RETURNING version`,
      [proposal.target, version],
    );
    if (urows.length === 0) {
      throw conflict('staged candidate version is no longer available');
    }
    const newOutcome = {
      ...outcome,
      activated: true,
      activatedVersion: version,
      gateEvidence: body.gateEvidence,
    };
    const { rows } = await db.query<ProposalRow>(
      `UPDATE improvement_proposals SET outcome = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(newOutcome)],
    );
    await audit(db, actor.raw, 'improvement.activate', id, {
      skillName: proposal.target,
      version,
      gateEvidence: body.gateEvidence,
    });
    return toProposalJson(rows[0] as ProposalRow);
  });

  fastify.post('/improvements/:id/rollback', async (req) => {
    const actor = actorOf(req);
    requireHuman(actor, 'roll back');
    const { id } = req.params as { id: string };
    const proposal = await requireProposal(db, id);
    if (proposal.status !== ImprovementStatus.APPLIED) {
      throw conflict(`cannot roll back a proposal in status '${proposal.status}'`);
    }
    const previous = (proposal.previous_state ?? {}) as Record<string, unknown>;
    const outcome = (proposal.outcome ?? {}) as Record<string, unknown>;
    let rollbackDetail: Record<string, unknown> = {};

    if (proposal.scope === ImprovementScope.CONFIG) {
      if (previous.existed) {
        await db.query(
          `UPDATE application_settings SET value = $2, updated_at = now() WHERE key = $1`,
          [proposal.target, JSON.stringify(previous.value)],
        );
      } else {
        await db.query(`DELETE FROM application_settings WHERE key = $1`, [proposal.target]);
      }
      rollbackDetail = { restored: previous.existed ? 'previous value' : 'key removed' };
    } else if (proposal.scope === ImprovementScope.PROMPT) {
      await db.query(
        `UPDATE skill_versions SET status = 'rolled_back'
         WHERE skill_name = $1 AND version = $2 AND status IN ('candidate','active')`,
        [proposal.target, Number(outcome.version ?? 0)],
      );
      rollbackDetail = { stagedVersionRolledBack: outcome.version ?? null };
    } else {
      // CODE scope never executed anything; rollback withdraws the staged diff.
      rollbackDetail = { stagedDiffWithdrawn: true };
    }

    const { rows } = await db.query<ProposalRow>(
      `UPDATE improvement_proposals
         SET status = 'rolled_back',
             outcome = $2,
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, JSON.stringify({ ...outcome, rollback: rollbackDetail })],
    );
    await audit(db, actor.raw, 'improvement.rollback', id, rollbackDetail);
    return toProposalJson(rows[0] as ProposalRow);
  });
}
