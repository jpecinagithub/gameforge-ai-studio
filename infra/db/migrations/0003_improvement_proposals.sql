-- 0003: self-improvement proposals (Phase 6, master prompt §6).
--
-- Evidence-gated, versioned improvement proposals with auto-apply OFF by
-- design. Applying a proposal always requires a prior human approval; agents
-- can never approve (they have no HTTP tool to reach the improvements API —
-- see apps/api/src/routes/improvements.ts).
--
-- Apply semantics are honest per scope:
--   prompt → stages a CANDIDATE row in skill_versions (never activates);
--            activation requires an explicit human + held-out gate evidence.
--   config → writes application_settings (rollbackable via previous_state).
--   code   → stores the unified diff for MANUAL review; code is NEVER
--            executed or written into the repo by apply.

CREATE TABLE improvement_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  title         text NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('prompt','config','code')),
  target        text NOT NULL,              -- prompt name | settings key | repo-relative path
  change        jsonb NOT NULL,             -- scope-bounded change payload
  evidence      jsonb NOT NULL,             -- [{kind:'build'|'review', id}]
  status        text NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed','approved','applied','rejected','rolled_back')),
  proposed_by   text NOT NULL,              -- actor identity
  approved_by   text,
  approved_at   timestamptz,
  applied_at    timestamptz,
  previous_state jsonb,                     -- rollback snapshot captured at apply time
  outcome       jsonb,                      -- apply result record
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX improvement_proposals_status ON improvement_proposals (status, created_at DESC);

-- Append-only version history: every superseded change payload is kept.
CREATE TABLE improvement_proposal_versions (
  proposal_id uuid NOT NULL REFERENCES improvement_proposals (id) ON DELETE CASCADE,
  version     integer NOT NULL CHECK (version >= 1),
  change      jsonb NOT NULL,
  evidence    jsonb NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, version)
);
