import { getDb } from "../../db/client/index.js";
import { setPermission } from "../../gateway/permissions/index.js";

type Category = "READ" | "WRITE" | "EXECUTE";
type State = "ALLOWED" | "DENIED" | "APPROVAL_REQUIRED";

export async function createPrincipal(name: string, timezone = "UTC") {
  return getDb().principal.create({ data: { name, timezone } });
}

export async function ensureAgent(key: string) {
  return getDb().agent.upsert({ where: { key }, update: {}, create: { key, name: key } });
}

export async function ensureSkill(key: string) {
  return getDb().skill.upsert({ where: { key }, update: {}, create: { key, name: key } });
}

export async function grant(
  principalId: string,
  agentKey: string,
  skillKey: string,
  resource: string,
  action: string,
  category: Category,
  state: State = "ALLOWED"
) {
  await ensureAgent(agentKey);
  await ensureSkill(skillKey);
  await setPermission({ principalId, agentKey, skillKey, resource, action, category, state });
}

export async function deletePrincipal(id: string) {
  await getDb().principal.delete({ where: { id } }).catch(() => undefined);
  // Audit history deliberately outlives its principal (no FK cascade); tests remove their own rows so the shared dev DB stays clean.
  await getDb().auditLog.deleteMany({ where: { principalId: id } }).catch(() => undefined);
}
