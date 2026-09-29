-- The audit append-only guard must not block the foreign-key action that detaches a deleted agent
-- (audit_logs.agentId ON DELETE SET NULL). It now refuses every UPDATE except exactly that: agentId → NULL with every other column unchanged.
DROP TRIGGER audit_logs_append_only ON "audit_logs";
CREATE OR REPLACE FUNCTION audit_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."agentId" IS NULL AND OLD."agentId" IS NOT NULL
     AND (to_jsonb(NEW) - 'agentId') = (to_jsonb(OLD) - 'agentId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION audit_immutable_guard();
