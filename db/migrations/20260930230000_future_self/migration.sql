-- CreateEnum
CREATE TYPE "AspirationStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'RELEASED');

-- CreateTable
CREATE TABLE "aspirations" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "area" TEXT,
    "current" TEXT NOT NULL,
    "gap" TEXT,
    "desired" TEXT NOT NULL,
    "goalId" TEXT,
    "nextTaskId" TEXT,
    "nextQuestId" TEXT,
    "status" "AspirationStatus" NOT NULL DEFAULT 'ACTIVE',
    "closedAt" TIMESTAMP(3),
    "closedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aspirations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "aspirationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "baseline" DOUBLE PRECISION NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_readings" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "metricId" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "resultId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aspirations_principalId_status_idx" ON "aspirations"("principalId", "status");

-- CreateIndex
CREATE INDEX "metrics_aspirationId_idx" ON "metrics"("aspirationId");

-- CreateIndex
CREATE INDEX "metrics_principalId_idx" ON "metrics"("principalId");

-- CreateIndex
CREATE INDEX "metric_readings_metricId_observedAt_idx" ON "metric_readings"("metricId", "observedAt");

-- CreateIndex
CREATE INDEX "metric_readings_principalId_idx" ON "metric_readings"("principalId");

-- AddForeignKey
ALTER TABLE "aspirations" ADD CONSTRAINT "aspirations_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_aspirationId_fkey" FOREIGN KEY ("aspirationId") REFERENCES "aspirations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_readings" ADD CONSTRAINT "metric_readings_metricId_fkey" FOREIGN KEY ("metricId") REFERENCES "metrics"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "aspirations" ADD CONSTRAINT "aspirations_closed_consistent" CHECK (("status" = 'ACTIVE') = ("closedAt" IS NULL));
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_range_valid" CHECK ("baseline" <> "target");

CREATE TRIGGER aspirations_owner_guard BEFORE INSERT OR UPDATE ON "aspirations"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('goalId', 'goals', 'nextTaskId', 'tasks', 'nextQuestId', 'quests');
CREATE TRIGGER metrics_owner_guard BEFORE INSERT OR UPDATE ON "metrics"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('aspirationId', 'aspirations');
CREATE TRIGGER metric_readings_owner_guard BEFORE INSERT OR UPDATE ON "metric_readings"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('metricId', 'metrics', 'resultId', 'results');

CREATE TRIGGER aspirations_immutable BEFORE UPDATE ON "aspirations"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{ACHIEVED,RELEASED}');
CREATE TRIGGER metrics_append_only BEFORE UPDATE ON "metrics" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER metric_readings_append_only BEFORE UPDATE ON "metric_readings" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
