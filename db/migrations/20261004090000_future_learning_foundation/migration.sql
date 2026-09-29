-- CreateEnum
CREATE TYPE "StateBasis" AS ENUM ('INITIAL', 'EVIDENCED');

-- CreateEnum
CREATE TYPE "EvidenceSubject" AS ENUM ('ASPIRATION_STATE', 'OBJECTIVE', 'EXPERIMENT');

-- CreateEnum
CREATE TYPE "EvidenceSource" AS ENUM ('RESULT', 'DECISION', 'MEMORY', 'TASK', 'QUEST', 'LEARNING_SESSION', 'METRIC_READING', 'OBSERVATION');

-- CreateEnum
CREATE TYPE "EvidenceStance" AS ENUM ('SUPPORTS', 'CONTRADICTS', 'CONTEXT');

-- CreateEnum
CREATE TYPE "ReadingProvenance" AS ENUM ('OWNER_REPORTED', 'MEASURED', 'DERIVED');

-- CreateEnum
CREATE TYPE "ObjectiveStatus" AS ENUM ('ACTIVE', 'MET', 'ABANDONED');

-- CreateEnum
CREATE TYPE "HypothesisStatus" AS ENUM ('CANDIDATE', 'OBSERVED', 'SUPPORTED', 'CONFIRMED', 'REJECTED');

-- AlterTable
ALTER TABLE "metric_readings" ADD COLUMN     "provenance" "ReadingProvenance" NOT NULL DEFAULT 'OWNER_REPORTED';

-- AlterTable
ALTER TABLE "metrics" ADD COLUMN     "definition" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "aspiration_states" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "aspirationId" TEXT NOT NULL,
    "current" TEXT NOT NULL,
    "gap" TEXT,
    "desired" TEXT NOT NULL,
    "basis" "StateBasis" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aspiration_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_links" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "subjectKind" "EvidenceSubject" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "sourceKind" "EvidenceSource" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "stance" "EvidenceStance" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_objectives" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "topicId" TEXT,
    "aspirationId" TEXT,
    "title" TEXT NOT NULL,
    "evidenceStandard" TEXT NOT NULL,
    "status" "ObjectiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "closedAt" TIMESTAMP(3),
    "closedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_experiments" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "objectiveId" TEXT,
    "hypothesis" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" "HypothesisStatus" NOT NULL DEFAULT 'CANDIDATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_observations" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_status_changes" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "fromStatus" "HypothesisStatus" NOT NULL,
    "toStatus" "HypothesisStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aspiration_states_aspirationId_createdAt_idx" ON "aspiration_states"("aspirationId", "createdAt");

-- CreateIndex
CREATE INDEX "aspiration_states_principalId_idx" ON "aspiration_states"("principalId");

-- CreateIndex
CREATE INDEX "evidence_links_principalId_subjectKind_subjectId_idx" ON "evidence_links"("principalId", "subjectKind", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_links_subjectKind_subjectId_sourceKind_sourceId_key" ON "evidence_links"("subjectKind", "subjectId", "sourceKind", "sourceId");

-- CreateIndex
CREATE INDEX "learning_objectives_principalId_status_idx" ON "learning_objectives"("principalId", "status");

-- CreateIndex
CREATE INDEX "learning_experiments_principalId_status_idx" ON "learning_experiments"("principalId", "status");

-- CreateIndex
CREATE INDEX "experiment_observations_experimentId_observedAt_idx" ON "experiment_observations"("experimentId", "observedAt");

-- CreateIndex
CREATE INDEX "experiment_observations_principalId_idx" ON "experiment_observations"("principalId");

-- CreateIndex
CREATE INDEX "experiment_status_changes_experimentId_createdAt_idx" ON "experiment_status_changes"("experimentId", "createdAt");

-- CreateIndex
CREATE INDEX "experiment_status_changes_principalId_idx" ON "experiment_status_changes"("principalId");

-- AddForeignKey
ALTER TABLE "aspiration_states" ADD CONSTRAINT "aspiration_states_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aspiration_states" ADD CONSTRAINT "aspiration_states_aspirationId_fkey" FOREIGN KEY ("aspirationId") REFERENCES "aspirations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_experiments" ADD CONSTRAINT "learning_experiments_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_experiments" ADD CONSTRAINT "learning_experiments_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "learning_objectives"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_observations" ADD CONSTRAINT "experiment_observations_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "learning_experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_status_changes" ADD CONSTRAINT "experiment_status_changes_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "learning_experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Hand-written integrity (same pattern as Life OS / Decisions) ─────────────
-- Backfill: every existing aspiration gets an INITIAL state so history is complete from day one.
INSERT INTO "aspiration_states" ("id", "principalId", "aspirationId", "current", "gap", "desired", "basis", "note", "createdAt")
SELECT gen_random_uuid()::text, "principalId", "id", "current", "gap", "desired", 'INITIAL', 'backfilled from the aspiration as it stood at migration', "createdAt" FROM "aspirations";

CREATE TRIGGER aspiration_states_owner_guard BEFORE INSERT ON "aspiration_states"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('aspirationId', 'aspirations');
CREATE TRIGGER learning_objectives_owner_guard BEFORE INSERT OR UPDATE ON "learning_objectives"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('topicId', 'learning_topics', 'aspirationId', 'aspirations');
CREATE TRIGGER learning_experiments_owner_guard BEFORE INSERT OR UPDATE ON "learning_experiments"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('objectiveId', 'learning_objectives');
CREATE TRIGGER experiment_observations_owner_guard BEFORE INSERT ON "experiment_observations"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('experimentId', 'learning_experiments');
CREATE TRIGGER experiment_status_changes_owner_guard BEFORE INSERT ON "experiment_status_changes"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('experimentId', 'learning_experiments');

CREATE TRIGGER learning_objectives_immutable BEFORE UPDATE ON "learning_objectives"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{MET,ABANDONED}');
CREATE TRIGGER learning_experiments_immutable BEFORE UPDATE ON "learning_experiments"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{CONFIRMED,REJECTED}');

CREATE TRIGGER aspiration_states_append_only BEFORE UPDATE ON "aspiration_states" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER evidence_links_append_only BEFORE UPDATE ON "evidence_links" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER experiment_observations_append_only BEFORE UPDATE ON "experiment_observations" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER experiment_status_changes_append_only BEFORE UPDATE ON "experiment_status_changes" FOR EACH ROW EXECUTE FUNCTION append_only_guard();

ALTER TABLE "learning_objectives" ADD CONSTRAINT "learning_objectives_closed_consistent"
  CHECK (("status" = 'ACTIVE') = ("closedAt" IS NULL));

-- Evidence links: the subject and the source must both belong to the link's principal.
CREATE OR REPLACE FUNCTION evidence_link_guard() RETURNS trigger AS $$
DECLARE
  subj text; src text; owner text;
BEGIN
  subj := CASE NEW."subjectKind"::text WHEN 'ASPIRATION_STATE' THEN 'aspiration_states' WHEN 'OBJECTIVE' THEN 'learning_objectives' WHEN 'EXPERIMENT' THEN 'learning_experiments' END;
  src := CASE NEW."sourceKind"::text WHEN 'RESULT' THEN 'results' WHEN 'DECISION' THEN 'decisions' WHEN 'MEMORY' THEN 'memories' WHEN 'TASK' THEN 'tasks'
    WHEN 'QUEST' THEN 'quests' WHEN 'LEARNING_SESSION' THEN 'learning_sessions' WHEN 'METRIC_READING' THEN 'metric_readings' WHEN 'OBSERVATION' THEN 'experiment_observations' END;
  IF subj IS NULL OR src IS NULL THEN RAISE EXCEPTION 'invalid evidence reference' USING ERRCODE = '23514'; END IF;
  EXECUTE format('SELECT "principalId" FROM %I WHERE "id" = $1', subj) INTO owner USING NEW."subjectId";
  IF owner IS NULL OR owner IS DISTINCT FROM NEW."principalId" THEN RAISE EXCEPTION 'cross-principal evidence subject' USING ERRCODE = '23514'; END IF;
  owner := NULL;
  EXECUTE format('SELECT "principalId" FROM %I WHERE "id" = $1', src) INTO owner USING NEW."sourceId";
  IF owner IS NULL OR owner IS DISTINCT FROM NEW."principalId" THEN RAISE EXCEPTION 'cross-principal evidence source' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER evidence_links_guard BEFORE INSERT ON "evidence_links" FOR EACH ROW EXECUTE FUNCTION evidence_link_guard();

-- A non-initial state must carry at least one evidence link by commit time (deferred so the store can insert both in one transaction).
CREATE OR REPLACE FUNCTION aspiration_state_requires_evidence() RETURNS trigger AS $$
BEGIN
  IF NEW."basis" <> 'INITIAL' AND NOT EXISTS (SELECT 1 FROM "evidence_links" WHERE "subjectKind" = 'ASPIRATION_STATE' AND "subjectId" = NEW."id") THEN
    RAISE EXCEPTION 'an evidenced state needs at least one evidence link' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER aspiration_states_evidence AFTER INSERT ON "aspiration_states"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aspiration_state_requires_evidence();
