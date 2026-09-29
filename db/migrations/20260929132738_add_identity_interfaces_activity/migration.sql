-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('TASK_COMPLETED', 'QUEST_COMPLETED', 'LEARNING_SESSION', 'KNOWLEDGE_ADDED', 'HABIT_COMPLETED', 'GOAL_PROGRESS', 'ACHIEVEMENT', 'MEETING', 'DECISION', 'MEMORY_CREATED');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "interfaceSource" TEXT,
ADD COLUMN     "requestId" TEXT;

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "interfaceSource" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_identities" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "interfaceSource" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interface_cursors" (
    "id" TEXT NOT NULL,
    "interfaceSource" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interface_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" TEXT NOT NULL,
    "area" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "interfaceSource" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "api_tokens_principalId_idx" ON "api_tokens"("principalId");

-- CreateIndex
CREATE INDEX "external_identities_principalId_idx" ON "external_identities"("principalId");

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_interfaceSource_externalId_key" ON "external_identities"("interfaceSource", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "interface_cursors_interfaceSource_name_key" ON "interface_cursors"("interfaceSource", "name");

-- CreateIndex
CREATE INDEX "activities_principalId_occurredAt_idx" ON "activities"("principalId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "activities_principalId_type_idx" ON "activities"("principalId", "type");

-- CreateIndex
CREATE INDEX "audit_logs_requestId_idx" ON "audit_logs"("requestId");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
