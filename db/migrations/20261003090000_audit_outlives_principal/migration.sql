-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_principalId_fkey";


-- Audit rows are never edited (only appended). Retention/purge is an explicit operator procedure, not a side effect of deleting a principal.
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
