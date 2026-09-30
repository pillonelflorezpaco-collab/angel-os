-- CreateEnum
CREATE TYPE "CaptureStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "capture_proposals" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "interfaceSource" TEXT NOT NULL,
    "proposal" JSONB NOT NULL,
    "proposalHash" TEXT NOT NULL,
    "status" "CaptureStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capture_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "capture_proposals_principalId_status_idx" ON "capture_proposals"("principalId", "status");

-- AddForeignKey
ALTER TABLE "capture_proposals" ADD CONSTRAINT "capture_proposals_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A draft's content is immutable; it can be decided exactly once; its outcome is written exactly once, after confirmation.
CREATE OR REPLACE FUNCTION capture_proposal_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."principalId" IS DISTINCT FROM OLD."principalId" OR NEW."proposal"::text IS DISTINCT FROM OLD."proposal"::text
     OR NEW."proposalHash" IS DISTINCT FROM OLD."proposalHash" OR NEW."interfaceSource" IS DISTINCT FROM OLD."interfaceSource"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'a capture proposal is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'PENDING' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'a decided capture proposal cannot change status' USING ERRCODE = '23514';
  END IF;
  IF OLD."outcome" IS NOT NULL AND NEW."outcome"::text IS DISTINCT FROM OLD."outcome"::text THEN
    RAISE EXCEPTION 'a capture outcome is written once' USING ERRCODE = '23514';
  END IF;
  IF NEW."outcome" IS NOT NULL AND NEW."status" <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'only a confirmed proposal has an outcome' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER capture_proposals_guard BEFORE UPDATE ON "capture_proposals" FOR EACH ROW EXECUTE FUNCTION capture_proposal_guard();
ALTER TABLE "capture_proposals" ADD CONSTRAINT "capture_proposals_decided_consistent" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL));
