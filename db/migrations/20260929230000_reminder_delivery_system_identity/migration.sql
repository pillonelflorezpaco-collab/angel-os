-- BUILD #7: reminder delivery lifecycle + audit/activity vocabulary.
-- Purely additive: existing reminders keep their data and stay PENDING/SENT/DISMISSED.
ALTER TYPE "ReminderStatus" ADD VALUE 'CLAIMED';
ALTER TYPE "ReminderStatus" ADD VALUE 'FAILED';
ALTER TYPE "ReminderStatus" ADD VALUE 'UNCONFIRMED';

ALTER TYPE "ActivityType" ADD VALUE 'REMINDER_DELIVERED';

ALTER TYPE "AuditEventType" ADD VALUE 'REMINDER_DELIVERY_STARTED';
ALTER TYPE "AuditEventType" ADD VALUE 'REMINDER_DELIVERED';
ALTER TYPE "AuditEventType" ADD VALUE 'REMINDER_DELIVERY_FAILED';
ALTER TYPE "AuditEventType" ADD VALUE 'REMINDER_DELIVERY_UNCONFIRMED';
ALTER TYPE "AuditEventType" ADD VALUE 'TOKEN_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'TOKEN_REVOKED';
ALTER TYPE "AuditEventType" ADD VALUE 'IDENTITY_LINKED';
ALTER TYPE "AuditEventType" ADD VALUE 'IDENTITY_UNLINKED';

ALTER TABLE "reminders"
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "sendStartedAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "deliveryChannel" TEXT,
  ADD COLUMN "lastDeliveryError" TEXT;

CREATE INDEX "reminders_status_remindAt_idx" ON "reminders"("status", "remindAt");
