-- BUILD #6: approval & execution engine.
-- Hand-written (Prisma cannot express the enum rename, the backfill, the
-- partial unique index, or the immutability trigger). Legacy approvals could
-- never be executed (the old executor was a closure), so any still-PENDING
-- row is expired rather than silently made executable.

-- Enums
ALTER TYPE "ApprovalStatus" RENAME VALUE 'REJECTED' TO 'DENIED';
ALTER TYPE "ApprovalStatus" ADD VALUE 'CONSUMED';
CREATE TYPE "ExecutionStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED');
ALTER TYPE "AuditEventType" ADD VALUE 'APPROVAL_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'APPROVAL_APPROVED';
ALTER TYPE "AuditEventType" ADD VALUE 'APPROVAL_DENIED';
ALTER TYPE "AuditEventType" ADD VALUE 'APPROVAL_EXPIRED';
ALTER TYPE "AuditEventType" ADD VALUE 'APPROVAL_CONSUMED';
ALTER TYPE "AuditEventType" ADD VALUE 'ACTION_EXECUTION_STARTED';
ALTER TYPE "AuditEventType" ADD VALUE 'ACTION_EXECUTION_SUCCEEDED';
ALTER TYPE "AuditEventType" ADD VALUE 'ACTION_EXECUTION_FAILED';

-- Columns
ALTER TABLE "approval_requests"
  ADD COLUMN "payloadHash" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "interfaceSource" TEXT,
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "decidedVia" TEXT,
  ADD COLUMN "consumedAt" TIMESTAMP(3),
  ADD COLUMN "executionStatus" "ExecutionStatus";
ALTER TABLE "approval_requests" ALTER COLUMN "payloadHash" DROP DEFAULT;

-- Legacy rows: an approval must always have an expiry, and none may stay actionable.
UPDATE "approval_requests" SET "expiresAt" = "requestedAt" WHERE "expiresAt" IS NULL;
UPDATE "approval_requests" SET "status" = 'EXPIRED' WHERE "status" = 'PENDING';
ALTER TABLE "approval_requests" ALTER COLUMN "expiresAt" SET NOT NULL;

-- Indexes: replace the single-column ones; at most one PENDING approval per
-- identical (principal, exact action) so a retried proposal cannot pile up.
DROP INDEX IF EXISTS "approval_requests_principalId_idx";
DROP INDEX IF EXISTS "approval_requests_status_idx";
CREATE INDEX "approval_requests_principalId_status_idx" ON "approval_requests"("principalId", "status");
CREATE INDEX "approval_requests_status_expiresAt_idx" ON "approval_requests"("status", "expiresAt");
CREATE UNIQUE INDEX "approval_requests_pending_payload_key"
  ON "approval_requests"("principalId", "payloadHash") WHERE "status" = 'PENDING';

-- Immutability + legal state transitions, enforced by the database itself.
CREATE OR REPLACE FUNCTION approval_requests_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."principalId" IS DISTINCT FROM OLD."principalId"
     OR NEW."agentId" IS DISTINCT FROM OLD."agentId"
     OR NEW."skillKey" IS DISTINCT FROM OLD."skillKey"
     OR NEW."resource" IS DISTINCT FROM OLD."resource"
     OR NEW."action" IS DISTINCT FROM OLD."action"
     OR NEW."parameters" IS DISTINCT FROM OLD."parameters"
     OR NEW."payloadHash" IS DISTINCT FROM OLD."payloadHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."interfaceSource" IS DISTINCT FROM OLD."interfaceSource"
     OR NEW."requestId" IS DISTINCT FROM OLD."requestId" THEN
    RAISE EXCEPTION 'approval_requests: bound action fields are immutable';
  END IF;

  IF NEW."status"::text <> OLD."status"::text AND NOT (
       (OLD."status"::text = 'PENDING'  AND NEW."status"::text IN ('APPROVED', 'DENIED', 'EXPIRED'))
    OR (OLD."status"::text = 'APPROVED' AND NEW."status"::text IN ('CONSUMED', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'approval_requests: illegal status transition % -> %', OLD."status", NEW."status";
  END IF;

  IF OLD."executionStatus" IS NOT NULL AND NEW."executionStatus" IS DISTINCT FROM OLD."executionStatus" AND NOT (
       OLD."executionStatus"::text = 'STARTED' AND NEW."executionStatus"::text IN ('SUCCEEDED', 'FAILED')
  ) THEN
    RAISE EXCEPTION 'approval_requests: illegal execution status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approval_requests_guard_trg
  BEFORE UPDATE ON "approval_requests"
  FOR EACH ROW EXECUTE FUNCTION approval_requests_guard();
