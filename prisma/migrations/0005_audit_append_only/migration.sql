-- Audit events are append-only: reject updates and deletes at the database level.
CREATE OR REPLACE FUNCTION "forbid_audit_event_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent records are append-only and cannot be modified';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AuditEvent_no_update" ON "AuditEvent";
CREATE TRIGGER "AuditEvent_no_update"
  BEFORE UPDATE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_event_mutation"();

DROP TRIGGER IF EXISTS "AuditEvent_no_delete" ON "AuditEvent";
CREATE TRIGGER "AuditEvent_no_delete"
  BEFORE DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "forbid_audit_event_mutation"();
