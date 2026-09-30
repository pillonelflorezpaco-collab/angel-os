-- CreateEnum
CREATE TYPE "RoutineKind" AS ENUM ('MEAL', 'HABIT', 'BLOCK', 'OTHER');

-- CreateEnum
CREATE TYPE "RoutineStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RoutineCheckStatus" AS ENUM ('DONE', 'SKIPPED');

-- CreateTable
CREATE TABLE "routines" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "RoutineKind" NOT NULL DEFAULT 'OTHER',
    "details" TEXT,
    "daysOfWeek" INTEGER[],
    "timeOfDay" TEXT NOT NULL,
    "durationMinutes" INTEGER,
    "status" "RoutineStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routine_checks" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "status" "RoutineCheckStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "routine_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "routines_principalId_status_idx" ON "routines"("principalId", "status");

-- CreateIndex
CREATE INDEX "routine_checks_principalId_day_idx" ON "routine_checks"("principalId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "routine_checks_routineId_day_key" ON "routine_checks"("routineId", "day");

-- AddForeignKey
ALTER TABLE "routines" ADD CONSTRAINT "routines_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_checks" ADD CONSTRAINT "routine_checks_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_checks" ADD CONSTRAINT "routine_checks_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity, same pattern as Life OS: same-principal references, immutable principal, terminal ARCHIVED, append-only check-ins.
CREATE TRIGGER routine_checks_owner_guard BEFORE INSERT OR UPDATE ON "routine_checks"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('routineId', 'routines');
CREATE TRIGGER routines_immutable BEFORE UPDATE ON "routines"
  FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{ARCHIVED}');
CREATE TRIGGER routine_checks_append_only BEFORE UPDATE ON "routine_checks" FOR EACH ROW EXECUTE FUNCTION append_only_guard();

ALTER TABLE "routines" ADD CONSTRAINT "routines_time_valid" CHECK ("timeOfDay" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "routines" ADD CONSTRAINT "routines_days_valid" CHECK (cardinality("daysOfWeek") BETWEEN 1 AND 7 AND "daysOfWeek" <@ ARRAY[0,1,2,3,4,5,6]);
ALTER TABLE "routines" ADD CONSTRAINT "routines_duration_valid" CHECK ("durationMinutes" IS NULL OR "durationMinutes" BETWEEN 1 AND 1440);
ALTER TABLE "routine_checks" ADD CONSTRAINT "routine_checks_day_valid" CHECK ("day" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$');
