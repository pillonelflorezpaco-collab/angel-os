-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('MEMORY', 'KNOWLEDGE', 'TASK', 'NOTE');

-- CreateEnum
CREATE TYPE "ResultSubject" AS ENUM ('GOAL', 'PROJECT', 'QUEST', 'DECISION');

-- AlterTable
ALTER TABLE "decisions" ADD COLUMN     "expected" TEXT,
ADD COLUMN     "lesson" TEXT,
ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "question" TEXT,
ADD COLUMN     "reasoning" TEXT,
ADD COLUMN     "reviewAt" TIMESTAMP(3),
ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "decision_options" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pros" TEXT,
    "cons" TEXT,
    "chosen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_evidence" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "refId" TEXT,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "results" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "subjectKind" "ResultSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "unit" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "wins" TEXT,
    "lessons" TEXT,
    "nextSteps" TEXT,
    "facts" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "decision_options_decisionId_idx" ON "decision_options"("decisionId");

-- CreateIndex
CREATE INDEX "decision_options_principalId_idx" ON "decision_options"("principalId");

-- CreateIndex
CREATE INDEX "decision_evidence_decisionId_idx" ON "decision_evidence"("decisionId");

-- CreateIndex
CREATE INDEX "decision_evidence_principalId_idx" ON "decision_evidence"("principalId");

-- CreateIndex
CREATE INDEX "results_principalId_recordedAt_idx" ON "results"("principalId", "recordedAt");

-- CreateIndex
CREATE INDEX "results_subjectKind_subjectId_idx" ON "results"("subjectKind", "subjectId");

-- CreateIndex
CREATE INDEX "reviews_principalId_periodEnd_idx" ON "reviews"("principalId", "periodEnd");

-- AddForeignKey
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_evidence" ADD CONSTRAINT "decision_evidence_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill-safe guards -----------------------------------------------------

-- Decision history is immutable; only the look-back can be filled in, once.
CREATE OR REPLACE FUNCTION decision_history_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."principalId" IS DISTINCT FROM OLD."principalId"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."context" IS DISTINCT FROM OLD."context"
     OR NEW."decision" IS DISTINCT FROM OLD."decision"
     OR NEW."question" IS DISTINCT FROM OLD."question"
     OR NEW."reasoning" IS DISTINCT FROM OLD."reasoning"
     OR NEW."expected" IS DISTINCT FROM OLD."expected"
     OR NEW."reviewAt" IS DISTINCT FROM OLD."reviewAt"
     OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
     OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId"
     OR (NEW."projectId" IS DISTINCT FROM OLD."projectId" AND NEW."projectId" IS NOT NULL) THEN
    RAISE EXCEPTION 'decision history is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."reviewedAt" IS NOT NULL
     AND (NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."lesson" IS DISTINCT FROM OLD."lesson" OR NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt") THEN
    RAISE EXCEPTION 'decision already reviewed' USING ERRCODE = '23514';
  END IF;
  IF OLD."reviewedAt" IS NULL AND (NEW."outcome" IS NOT NULL OR NEW."lesson" IS NOT NULL) AND NEW."reviewedAt" IS NULL THEN
    RAISE EXCEPTION 'a review needs reviewedAt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER decisions_history BEFORE UPDATE ON "decisions" FOR EACH ROW EXECUTE FUNCTION decision_history_guard();

-- Ownership: supersession, options and evidence stay inside one principal.
DROP TRIGGER decisions_owner_guard ON "decisions";
CREATE TRIGGER decisions_owner_guard BEFORE INSERT OR UPDATE ON "decisions"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('projectId', 'projects', 'supersedesId', 'decisions');
CREATE TRIGGER decision_options_owner_guard BEFORE INSERT OR UPDATE ON "decision_options"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('decisionId', 'decisions');
CREATE TRIGGER decision_evidence_owner_guard BEFORE INSERT OR UPDATE ON "decision_evidence"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('decisionId', 'decisions');

-- At most one chosen option per decision.
CREATE UNIQUE INDEX "decision_options_one_chosen" ON "decision_options"("decisionId") WHERE "chosen";

-- Polymorphic references (evidence -> memory/knowledge/task, result -> goal/project/quest/decision)
-- must point at a row owned by the same principal.
CREATE OR REPLACE FUNCTION polymorphic_owner_guard() RETURNS trigger AS $$
DECLARE
  kind text := to_jsonb(NEW) ->> TG_ARGV[0];
  refid text := to_jsonb(NEW) ->> TG_ARGV[1];
  reftable text;
  owner text;
BEGIN
  IF kind = 'NOTE' THEN
    IF refid IS NOT NULL THEN RAISE EXCEPTION 'a note has no reference' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  reftable := CASE kind
    WHEN 'MEMORY' THEN 'memories' WHEN 'KNOWLEDGE' THEN 'knowledge_items' WHEN 'TASK' THEN 'tasks'
    WHEN 'GOAL' THEN 'goals' WHEN 'PROJECT' THEN 'projects' WHEN 'QUEST' THEN 'quests' WHEN 'DECISION' THEN 'decisions' END;
  IF reftable IS NULL OR refid IS NULL THEN RAISE EXCEPTION 'invalid reference' USING ERRCODE = '23514'; END IF;
  EXECUTE format('SELECT "principalId" FROM %I WHERE "id" = $1', reftable) INTO owner USING refid;
  IF owner IS NULL OR owner IS DISTINCT FROM NEW."principalId" THEN
    RAISE EXCEPTION 'cross-principal reference: %.% -> %', TG_TABLE_NAME, TG_ARGV[1], reftable USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER decision_evidence_ref_guard BEFORE INSERT ON "decision_evidence"
  FOR EACH ROW EXECUTE FUNCTION polymorphic_owner_guard('kind', 'refId');
CREATE TRIGGER results_ref_guard BEFORE INSERT ON "results"
  FOR EACH ROW EXECUTE FUNCTION polymorphic_owner_guard('subjectKind', 'subjectId');

-- Append-only: options, evidence, results and reviews are never edited.
CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER decision_options_append_only BEFORE UPDATE ON "decision_options" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER decision_evidence_append_only BEFORE UPDATE ON "decision_evidence" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER results_append_only BEFORE UPDATE ON "results" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER reviews_append_only BEFORE UPDATE ON "reviews" FOR EACH ROW EXECUTE FUNCTION append_only_guard();

ALTER TABLE "reviews" ADD CONSTRAINT "reviews_period_valid" CHECK ("periodEnd" > "periodStart");
