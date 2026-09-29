import { getDb } from "../db/client/index.js";

/** Creates a fresh Principal + registry rows for one test, isolated by a unique agent/skill key suffix. */
export async function seedTestFixtures(suffix: string) {
  const db = getDb();

  const principal = await db.principal.create({ data: { name: `Test Principal ${suffix}` } });

  const agent = await db.agent.create({
    data: { key: `test-agent-${suffix}`, name: "Test Agent" },
  });

  const skill = await db.skill.create({
    data: { key: `test.skill.${suffix}`, name: "Test Skill" },
  });

  return { principal, agent, skill };
}

export async function cleanupPrincipal(principalId: string) {
  const db = getDb();
  await db.principal.delete({ where: { id: principalId } }).catch(() => undefined);
}

export async function cleanupAgentAndSkill(agentId: string, skillId: string) {
  const db = getDb();
  await db.agent.delete({ where: { id: agentId } }).catch(() => undefined);
  await db.skill.delete({ where: { id: skillId } }).catch(() => undefined);
}
