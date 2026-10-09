import { z } from 'zod';

/**
 * Consent-card protocol — Phase 6.
 *
 * Some plugin actions need explicit human approval (install, enable, panel
 * actions with side effects). The host renders a consent card; a HUMAN
 * decides. Agents can never answer, bypass, or pre-approve consent cards —
 * this is enforced in code, not just documented.
 */

export const consentActorSchema = z.object({
  kind: z.enum(['human', 'agent']),
  /** Present for agent actors, e.g. `agent:director`. */
  id: z.string().max(64).optional(),
});
export type ConsentActor = z.infer<typeof consentActorSchema>;

export const consentDecisionSchema = z.enum(['approved', 'denied']);
export type ConsentDecision = z.infer<typeof consentDecisionSchema>;

export const consentCardSchema = z.object({
  id: z.string().min(1).max(128),
  pluginId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  /** Machine-readable summary of what approval grants. */
  grants: z.array(z.string().max(200)).default([]),
  decision: consentDecisionSchema.nullable().default(null),
  decidedBy: consentActorSchema.nullable().default(null),
  decidedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type ConsentCard = z.infer<typeof consentCardSchema>;

export function createConsentCard(input: {
  id: string;
  pluginId: string;
  title: string;
  body: string;
  grants?: string[];
}): ConsentCard {
  return consentCardSchema.parse({
    ...input,
    grants: input.grants ?? [],
    decision: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: new Date().toISOString(),
  });
}

export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

/**
 * Record a decision on a consent card. HARD RULE: agent actors are rejected —
 * no agent may approve or deny a consent card, even on the human's behalf.
 */
export function recordDecision(
  card: ConsentCard,
  decision: ConsentDecision,
  actor: ConsentActor,
): ConsentCard {
  const parsedActor = consentActorSchema.parse(actor);
  if (parsedActor.kind === 'agent') {
    throw new ConsentError(
      'Agents can never decide consent cards (attempted by ' +
        (parsedActor.id ?? 'unknown agent') +
        '). A human must decide.',
    );
  }
  if (card.decision !== null) {
    throw new ConsentError(`Consent card ${card.id} was already decided`);
  }
  return consentCardSchema.parse({
    ...card,
    decision: consentDecisionSchema.parse(decision),
    decidedBy: parsedActor,
    decidedAt: new Date().toISOString(),
  });
}

/** Convenience: true only when a human approved. */
export function isApproved(card: ConsentCard): boolean {
  return card.decision === 'approved' && card.decidedBy?.kind === 'human';
}
