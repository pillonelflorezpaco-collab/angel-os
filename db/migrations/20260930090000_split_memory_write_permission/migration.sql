-- BUILD #8: memory write authority is split (MEMORY_CREATE / UPDATE / CONFIRM / DELETE).
-- Data-only. Existing MEMORY_WRITE grants become MEMORY_CREATE (create authority
-- only). UPDATE/CONFIRM/DELETE get NO automatic grant: they stay DENIED until
-- explicitly granted (re-run `npm run db:seed` for the seeded principal).
UPDATE "permissions" SET "action" = 'MEMORY_CREATE'
WHERE "action" = 'MEMORY_WRITE'
  AND "skillId" IN (SELECT "id" FROM "skills" WHERE "key" = 'system.memory')
  AND NOT EXISTS (
    SELECT 1 FROM "permissions" p2
    WHERE p2."principalId" = "permissions"."principalId" AND p2."agentId" = "permissions"."agentId"
      AND p2."skillId" = "permissions"."skillId" AND p2."resource" = "permissions"."resource" AND p2."action" = 'MEMORY_CREATE'
  );
