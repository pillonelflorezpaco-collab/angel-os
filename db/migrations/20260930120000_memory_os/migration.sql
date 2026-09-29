-- BUILD #9 (Memory OS): provenance, temporal validity, lessons/relationships/context,
-- non-destructive retraction and append-only revision history.
-- Additive. Existing memories keep their data; INFERENCE/EXPERIENCE rows get the
-- matching provenance so the new invariants hold for old data too.

ALTER TYPE "MemoryType" ADD VALUE 'LESSON';
ALTER TYPE "MemoryType" ADD VALUE 'RELATIONSHIP';
ALTER TYPE "MemoryType" ADD VALUE 'CONTEXT';

CREATE TYPE "ProvenanceKind" AS ENUM ('STATED', 'OBSERVED', 'EXPERIENCED', 'INFERRED');

ALTER TABLE "memories"
  ADD COLUMN "provenance" "ProvenanceKind" NOT NULL DEFAULT 'STATED',
  ADD COLUMN "sourceRef" TEXT,
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "occurredAt" TIMESTAMP(3),
  ADD COLUMN "validFrom" TIMESTAMP(3),
  ADD COLUMN "validUntil" TIMESTAMP(3),
  ADD COLUMN "derivedFromId" TEXT,
  ADD COLUMN "retractedAt" TIMESTAMP(3),
  ADD COLUMN "retractedReason" TEXT;

UPDATE "memories" SET "provenance" = 'INFERRED' WHERE "type"::text = 'INFERENCE';
UPDATE "memories" SET "provenance" = 'EXPERIENCED' WHERE "type"::text = 'EXPERIENCE';
-- An old unconfirmed inference must not sit at full confidence.
UPDATE "memories" SET "confidence" = 0.99
  WHERE "type"::text = 'INFERENCE' AND "status"::text = 'UNCONFIRMED' AND "confidence" >= 1;

-- Old rows that were already RETRACTED (the previous provider allowed setting that status) get a retraction time so the new constraint holds.
UPDATE "memories" SET "retractedAt" = "updatedAt" WHERE "status"::text = 'RETRACTED' AND "retractedAt" IS NULL;

ALTER TABLE "memories" ADD CONSTRAINT "memories_derivedFromId_fkey"
  FOREIGN KEY ("derivedFromId") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "memories_principalId_subject_idx" ON "memories"("principalId", "subject");

-- Semantic invariants, enforced by the database itself.
ALTER TABLE "memories" ADD CONSTRAINT "memories_inference_provenance_chk"
  CHECK (("type"::text = 'INFERENCE') = ("provenance"::text = 'INFERRED'));
ALTER TABLE "memories" ADD CONSTRAINT "memories_experience_provenance_chk"
  CHECK ("type"::text <> 'EXPERIENCE' OR "provenance"::text = 'EXPERIENCED');
ALTER TABLE "memories" ADD CONSTRAINT "memories_confidence_range_chk"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);
ALTER TABLE "memories" ADD CONSTRAINT "memories_unconfirmed_inference_chk"
  CHECK (NOT ("type"::text = 'INFERENCE' AND "status"::text = 'UNCONFIRMED' AND "confidence" >= 1));
ALTER TABLE "memories" ADD CONSTRAINT "memories_validity_order_chk"
  CHECK ("validFrom" IS NULL OR "validUntil" IS NULL OR "validFrom" < "validUntil");
ALTER TABLE "memories" ADD CONSTRAINT "memories_retraction_chk"
  CHECK (("status"::text = 'RETRACTED') = ("retractedAt" IS NOT NULL));

-- Identity of a memory is immutable: what it IS (owner, type, provenance,
-- origin link) can never be rewritten — so an inference can never be turned
-- into a fact by an UPDATE. Status moves only forward; RETRACTED and EXPIRED are terminal.
CREATE OR REPLACE FUNCTION memories_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."principalId" IS DISTINCT FROM OLD."principalId"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."provenance" IS DISTINCT FROM OLD."provenance"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."derivedFromId" IS DISTINCT FROM OLD."derivedFromId" AND OLD."derivedFromId" IS NOT NULL AND NEW."derivedFromId" IS NOT NULL THEN
    RAISE EXCEPTION 'memories: owner, type, provenance and origin are immutable';
  END IF;
  IF NEW."status"::text <> OLD."status"::text AND NOT (
       (OLD."status"::text = 'UNCONFIRMED' AND NEW."status"::text IN ('ACTIVE', 'EXPIRED', 'RETRACTED'))
    OR (OLD."status"::text = 'ACTIVE' AND NEW."status"::text IN ('EXPIRED', 'RETRACTED'))
  ) THEN
    RAISE EXCEPTION 'memories: illegal status transition % -> %', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER memories_guard_trg BEFORE UPDATE ON "memories"
  FOR EACH ROW EXECUTE FUNCTION memories_guard();

CREATE TABLE "memory_revisions" (
  "id" TEXT NOT NULL,
  "memoryId" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "changeType" TEXT NOT NULL,
  "previousContent" TEXT NOT NULL,
  "previousConfidence" DOUBLE PRECISION NOT NULL,
  "previousStatus" "MemoryStatus" NOT NULL,
  "previousValidFrom" TIMESTAMP(3),
  "previousValidUntil" TIMESTAMP(3),
  "previousExpiresAt" TIMESTAMP(3),
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestId" TEXT,
  "interfaceSource" TEXT,
  "approvalId" TEXT,
  CONSTRAINT "memory_revisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "memory_revisions_memoryId_changedAt_idx" ON "memory_revisions"("memoryId", "changedAt");
CREATE INDEX "memory_revisions_principalId_idx" ON "memory_revisions"("principalId");
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_memoryId_fkey"
  FOREIGN KEY ("memoryId") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_principalId_fkey"
  FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- History is append-only: revisions can be added (and cascade away with their memory), never edited.
CREATE OR REPLACE FUNCTION memory_revisions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'memory_revisions is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER memory_revisions_immutable_trg BEFORE UPDATE ON "memory_revisions"
  FOR EACH ROW EXECUTE FUNCTION memory_revisions_immutable();
