-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'ERROR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'CONNECTION_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'CONNECTION_DISABLED';
ALTER TYPE "AuditEventType" ADD VALUE 'CONNECTION_REMOVED';
ALTER TYPE "AuditEventType" ADD VALUE 'CONNECTION_AUTHORIZED';
ALTER TYPE "AuditEventType" ADD VALUE 'CONNECTION_FAILED';

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "credentialRef" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connections_principalId_idx" ON "connections"("principalId");

-- CreateIndex
CREATE UNIQUE INDEX "connections_principalId_provider_externalAccountId_key" ON "connections"("principalId", "provider", "externalAccountId");

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
