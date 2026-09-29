-- CreateEnum
CREATE TYPE "TopicStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CardStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateTable
CREATE TABLE "learning_topics" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "area" TEXT,
    "intent" TEXT,
    "goalId" TEXT,
    "status" "TopicStatus" NOT NULL DEFAULT 'ACTIVE',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_sessions" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "studiedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "knowledgeItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_cards" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "knowledgeItemId" TEXT,
    "status" "CardStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_reviews" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "grade" INTEGER NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learning_topics_principalId_status_idx" ON "learning_topics"("principalId", "status");

-- CreateIndex
CREATE INDEX "learning_sessions_topicId_studiedAt_idx" ON "learning_sessions"("topicId", "studiedAt");

-- CreateIndex
CREATE INDEX "learning_sessions_principalId_studiedAt_idx" ON "learning_sessions"("principalId", "studiedAt");

-- CreateIndex
CREATE INDEX "learning_cards_topicId_idx" ON "learning_cards"("topicId");

-- CreateIndex
CREATE INDEX "learning_cards_principalId_status_idx" ON "learning_cards"("principalId", "status");

-- CreateIndex
CREATE INDEX "card_reviews_cardId_reviewedAt_idx" ON "card_reviews"("cardId", "reviewedAt");

-- CreateIndex
CREATE INDEX "card_reviews_principalId_idx" ON "card_reviews"("principalId");

-- AddForeignKey
ALTER TABLE "learning_topics" ADD CONSTRAINT "learning_topics_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_sessions" ADD CONSTRAINT "learning_sessions_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "learning_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_cards" ADD CONSTRAINT "learning_cards_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "learning_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "learning_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "learning_topics" ADD CONSTRAINT "learning_topics_completed_consistent" CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL));
ALTER TABLE "learning_sessions" ADD CONSTRAINT "learning_sessions_minutes_valid" CHECK ("minutes" BETWEEN 1 AND 720);
ALTER TABLE "card_reviews" ADD CONSTRAINT "card_reviews_grade_valid" CHECK ("grade" BETWEEN 0 AND 3);

CREATE TRIGGER learning_topics_owner_guard BEFORE INSERT OR UPDATE ON "learning_topics"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('goalId', 'goals');
CREATE TRIGGER learning_sessions_owner_guard BEFORE INSERT OR UPDATE ON "learning_sessions"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('topicId', 'learning_topics', 'knowledgeItemId', 'knowledge_items');
CREATE TRIGGER learning_cards_owner_guard BEFORE INSERT OR UPDATE ON "learning_cards"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('topicId', 'learning_topics', 'knowledgeItemId', 'knowledge_items');
CREATE TRIGGER card_reviews_owner_guard BEFORE INSERT OR UPDATE ON "card_reviews"
  FOR EACH ROW EXECUTE FUNCTION life_owner_guard('cardId', 'learning_cards');

CREATE TRIGGER learning_topics_immutable BEFORE UPDATE ON "learning_topics" FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{COMPLETED}');
CREATE TRIGGER learning_cards_immutable BEFORE UPDATE ON "learning_cards" FOR EACH ROW EXECUTE FUNCTION life_immutable_guard('{RETIRED}');
CREATE TRIGGER learning_sessions_append_only BEFORE UPDATE ON "learning_sessions" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER card_reviews_append_only BEFORE UPDATE ON "card_reviews" FOR EACH ROW EXECUTE FUNCTION append_only_guard();
