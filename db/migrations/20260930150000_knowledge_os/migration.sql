-- BUILD #10 (Knowledge OS): principal-owned sources, typed items, typed relations.
-- Purely additive. The legacy knowledge_documents table (unused) is left untouched.

CREATE TYPE "KnowledgeKind" AS ENUM ('FACT','CONCEPT','PRINCIPLE','METHOD','PERSON','EVENT','DATE','QUESTION','HYPOTHESIS','INSIGHT','CONTRADICTION','EXPERIENCE');
CREATE TYPE "KnowledgeRelationKind" AS ENUM ('RELATED_TO','EXPLAINS','SUPPORTS','CONTRADICTS','CAUSES','EXAMPLE_OF','APPLIES_TO','INSPIRED_BY','DERIVED_FROM','PART_OF','SIMILAR_TO');
CREATE TYPE "KnowledgeStatus" AS ENUM ('ACTIVE','RETRACTED');
CREATE TYPE "KnowledgeOrigin" AS ENUM ('INGESTED','MANUAL');

CREATE TABLE "knowledge_sources" (
  "id" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "uri" TEXT,
  "contentHash" TEXT NOT NULL,
  "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "knowledge_sources_principalId_contentHash_key" ON "knowledge_sources"("principalId","contentHash");
CREATE INDEX "knowledge_sources_principalId_idx" ON "knowledge_sources"("principalId");

CREATE TABLE "knowledge_items" (
  "id" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "kind" "KnowledgeKind" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "origin" "KnowledgeOrigin" NOT NULL,
  "sourceId" TEXT,
  "confidence" DOUBLE PRECISION,
  "eventAt" TIMESTAMP(3),
  "status" "KnowledgeStatus" NOT NULL DEFAULT 'ACTIVE',
  "retractedAt" TIMESTAMP(3),
  "retractedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "knowledge_items_principalId_kind_idx" ON "knowledge_items"("principalId","kind");
CREATE INDEX "knowledge_items_principalId_status_idx" ON "knowledge_items"("principalId","status");
CREATE INDEX "knowledge_items_sourceId_idx" ON "knowledge_items"("sourceId");

CREATE TABLE "knowledge_relations" (
  "id" TEXT NOT NULL,
  "principalId" TEXT NOT NULL,
  "fromId" TEXT NOT NULL,
  "toId" TEXT NOT NULL,
  "kind" "KnowledgeRelationKind" NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_relations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "knowledge_relations_fromId_toId_kind_key" ON "knowledge_relations"("fromId","toId","kind");
CREATE INDEX "knowledge_relations_principalId_idx" ON "knowledge_relations"("principalId");
CREATE INDEX "knowledge_relations_toId_idx" ON "knowledge_relations"("toId");

ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_toId_fkey" FOREIGN KEY ("toId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Semantic invariants (database-enforced).
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_confidence_chk" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_origin_chk" CHECK (("origin"::text = 'INGESTED') = ("sourceId" IS NOT NULL));
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_retraction_chk" CHECK (("status"::text = 'RETRACTED') = ("retractedAt" IS NOT NULL));
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_no_self_chk" CHECK ("fromId" <> "toId");

-- What a knowledge item IS never changes: owner, kind, origin, source. A hypothesis cannot be edited into a fact.
-- RETRACTED is terminal.
CREATE OR REPLACE FUNCTION knowledge_items_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."principalId" IS DISTINCT FROM OLD."principalId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."sourceId" IS DISTINCT FROM OLD."sourceId" AND OLD."sourceId" IS NOT NULL) THEN
    RAISE EXCEPTION 'knowledge_items: owner, kind, origin and source are immutable';
  END IF;
  IF OLD."status"::text = 'RETRACTED' AND NEW."status"::text <> 'RETRACTED' THEN
    RAISE EXCEPTION 'knowledge_items: RETRACTED is terminal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER knowledge_items_guard_trg BEFORE UPDATE ON "knowledge_items"
  FOR EACH ROW EXECUTE FUNCTION knowledge_items_guard();

-- A relation may only join two items owned by the SAME principal as the relation itself.
CREATE OR REPLACE FUNCTION knowledge_relations_owner_guard() RETURNS trigger AS $$
DECLARE
  from_owner TEXT;
  to_owner TEXT;
BEGIN
  SELECT "principalId" INTO from_owner FROM "knowledge_items" WHERE "id" = NEW."fromId";
  SELECT "principalId" INTO to_owner FROM "knowledge_items" WHERE "id" = NEW."toId";
  IF from_owner IS DISTINCT FROM NEW."principalId" OR to_owner IS DISTINCT FROM NEW."principalId" THEN
    RAISE EXCEPTION 'knowledge_relations: both items must belong to the relation''s principal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER knowledge_relations_owner_guard_trg BEFORE INSERT ON "knowledge_relations"
  FOR EACH ROW EXECUTE FUNCTION knowledge_relations_owner_guard();
