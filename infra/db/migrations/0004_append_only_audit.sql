-- 0004_append_only_audit.sql
-- Phase 7 hardening (THREAT_MODEL.md T12): make the event/audit tables
-- append-only at the database level. The application never UPDATEs or DELETEs
-- these tables (verified: only INSERTs in the codebase), so a trigger guard is
-- safe. Retention/purge, if ever needed, must be done by a separate privileged
-- procedure that drops these triggers first — that is the documented escape
-- hatch, not a back door.
--
-- NOTE: this migration was written without a live Postgres in the build VM.
-- It MUST be verified on the Oracle host at first deploy (the API logs each
-- applied migration; a failure aborts boot loudly rather than silently).

CREATE OR REPLACE FUNCTION prevent_mutation_of_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: UPDATE/DELETE forbidden', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_mutation ON audit_events;
CREATE TRIGGER audit_events_no_mutation
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation_of_append_only();

DROP TRIGGER IF EXISTS agent_events_no_mutation ON agent_events;
CREATE TRIGGER agent_events_no_mutation
  BEFORE UPDATE OR DELETE ON agent_events
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation_of_append_only();
