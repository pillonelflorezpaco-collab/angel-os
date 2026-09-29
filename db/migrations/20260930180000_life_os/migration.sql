-- CreateEnum
CREATE TYPE "VisionStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QuestStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'ABANDONED');

-- AlterTable
ALTER TABLE "goals" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedNote" TEXT,
ADD COLUMN     "targetDate" TIMESTAMP(3),
ADD COLUMN     "visionId" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "goalId" TEXT,
ADD COLUMN     "targetDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "questId" TEXT;

-- CreateTable
CREATE TABLE "visions" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "status" "VisionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quests" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "criteria" TEXT NOT NULL,
    "status" "QuestStatus" NOT NULL DEFAULT 'PLANNED',
    "dueAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_people" (
    "projectId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_people_pkey" PRIMARY KEY ("projectId","personId")
);

-- CreateTable
CREATE TABLE "project_knowledge" (
    "projectId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_knowledge_pkey" PRIMARY KEY ("projectId","itemId")
);

-- CreateIndex
CREATE INDEX "visions_principalId_idx" ON "visions"("principalId");

-- CreateIndex
CREATE INDEX "quests_principalId_status_idx" ON "quests"("principalId", "status");

-- CreateIndex
CREATE INDEX "quests_projectId_idx" ON "quests"("projectId");

-- CreateIndex
CREATE INDEX "project_people_principalId_idx" ON "project_people"("principalId");

-- CreateIndex
CREATE INDEX "project_knowledge_principalId_idx" ON "project_knowledge"("principalId");

-- CreateIndex
CREATE INDEX "goals_visionId_idx" ON "goals"("visionId");

-- CreateIndex
CREATE INDEX "tasks_questId_idx" ON "tasks"("questId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_questId_fkey" FOREIGN KEY ("questId") REFERENCES "quests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visions" ADD CONSTRAINT "visions_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quests" ADD CONSTRAINT "quests_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quests" ADD CONSTRAINT "quests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_people" ADD CONSTRAINT "project_people_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_people" ADD CONSTRAINT "project_people_personId_fkey" FOREIGN KEY ("personId") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_knowledge" ADD CONSTRAINT "project_knowledge_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_knowledge" ADD CONSTRAINT "project_knowledge_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_visionId_fkey" FOREIGN KEY ("visionId") REFERENCES "visions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: existing DONE tasks get a completion instant.
UPDATE "tasks" SET "completedAt" = "updatedAt" WHERE "status" = 'DONE' AND "completedAt" IS NULL;
UPDATE "goals" SET "closedAt" = "updatedAt" WHERE "status" <> 'ACTIVE' AND "closedAt" IS NULL;

-- Lifecycle consistency.
ALTER TABLE "goals" ADD CONSTRAINT "goals_closed_consistent"
  CHECK (("status" = 'ACTIVE') = ("closedAt" IS NULL));
ALTER TABLE "quests" ADD CONSTRAINT "quests_closed_consistent"
  CHECK (("status" IN ('COMPLETED','ABANDONED')) = ("closedAt" IS NOT NULL));
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_consistent"
  CHECK (("status" = 'DONE') = ("completedAt" IS NOT NULL));

-- Same-principal guard: every reference must point at a row owned by the same principal.
CREATE OR REPLACE FUNCTION life_owner_guard() RETURNS trigger AS $$
DECLARE
  col text;
  reftable text;
  refid text;
  owner text;
  i int := 0;
BEGIN
  WHILE i < TG_NARGS LOOP
    col := TG_ARGV[i];
    reftable := TG_ARGV[i + 1];
    refid := to_jsonb(NEW) ->> col;
    IF refid IS NOT NULL THEN
      EXECUTE format('SELECT "principalId" FROM %I WHERE "id" = $1', reftable) INTO owner USING refid;
      IF owner IS NULL OR owner IS DISTINCT FROM NEW."principalId" THEN
        RAISE EXCEPTION 'cross-principal reference: %.% -> %', TG_TABLE_NAME, col, reftable
          USING ERRCODE = '23514';
      END IF;
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER goals_owner_guard BEFORE INSERT OR UPDATE ON "goals"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('visionId', 'visions');
CREATE TRIGGER projects_owner_guard BEFORE INSERT OR UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('goalId', 'goals');
CREATE TRIGGER quests_owner_guard BEFORE INSERT OR UPDATE ON "quests"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('projectId', 'projects');
CREATE TRIGGER tasks_owner_guard BEFORE INSERT OR UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('projectId', 'projects', 'questId', 'quests', 'relatedPersonId', 'people');
CREATE TRIGGER decisions_owner_guard BEFORE INSERT OR UPDATE ON "decisions"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('projectId', 'projects');
CREATE TRIGGER project_people_owner_guard BEFORE INSERT OR UPDATE ON "project_people"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('projectId', 'projects', 'personId', 'people');
CREATE TRIGGER project_knowledge_owner_guard BEFORE INSERT OR UPDATE ON "project_knowledge"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('projectId', 'projects', 'itemId', 'knowledge_items');

-- Owner immutability + terminal states never reopen.
CREATE OR REPLACE FUNCTION life_immutable_guard() RETURNS trigger AS $$
DECLARE
  terminal text[] := TG_ARGV[0]::text[];
BEGIN
  IF NEW."principalId" IS DISTINCT FROM OLD."principalId" THEN
    RAISE EXCEPTION 'principalId is immutable on %', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF to_jsonb(OLD) ->> 'status' = ANY (terminal)
     AND to_jsonb(NEW) ->> 'status' IS DISTINCT FROM to_jsonb(OLD) ->> 'status' THEN
    RAISE EXCEPTION 'terminal status cannot change on %', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER visions_immutable BEFORE UPDATE ON "visions"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{ARCHIVED}');
CREATE TRIGGER goals_immutable BEFORE UPDATE ON "goals"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{ACHIEVED,ABANDONED}');
CREATE TRIGGER projects_immutable BEFORE UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{ARCHIVED}');
CREATE TRIGGER quests_immutable BEFORE UPDATE ON "quests"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{COMPLETED,ABANDONED}');
CREATE TRIGGER tasks_immutable BEFORE UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{DONE,CANCELLED}');
CREATE TRIGGER people_immutable BEFORE UPDATE ON "people"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{}');
