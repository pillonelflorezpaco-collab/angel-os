import { getDb } from "../../db/client/index.js";
import type { ActionDefinition } from "./types.js";
import { validateDefinition } from "./registry.js";

/**
 * Startup invariant (production composition roots call this before serving).
 * For the CONFIGURED production principal, every registered ActionDefinition
 * must have:
 *   - a structurally complete definition and a defined interface policy,
 *   - a registered Skill and Agent,
 *   - a permission row for (principal, agent, skill, resource, action) whose
 *     category matches the definition's and whose state is not DENIED.
 * A permission held only by some OTHER principal does not count. Anything
 * less means the action could not work as designed for the real owner, so
 * startup fails (fail closed).
 */
export async function verifyRegisteredActions(
  definitions: ActionDefinition<unknown>[],
  principalId: string
): Promise<void> {
  if (typeof principalId !== "string" || !principalId.trim()) {
    throw new Error("Action registry verification requires the configured production principal.");
  }
  const db = getDb();
  const problems: string[] = [];

  const principal = await db.principal.findUnique({ where: { id: principalId }, select: { id: true } });
  if (!principal) problems.push(`the configured production principal ${principalId} does not exist`);

  for (const d of definitions) {
    const label = `${d.skillKey}/${d.action}`;
    for (const problem of validateDefinition(d)) problems.push(`${label}: ${problem}`);
    const [skill, agent] = await Promise.all([
      db.skill.findUnique({ where: { key: d.skillKey } }),
      db.agent.findUnique({ where: { key: d.agentKey } }),
    ]);
    if (!skill) problems.push(`${label}: skill "${d.skillKey}" is not registered`);
    if (!agent) problems.push(`${label}: agent "${d.agentKey}" is not registered`);
    if (skill && agent && principal) {
      const permission = await db.permission.findUnique({
        where: {
          principalId_agentId_skillId_resource_action: { principalId, agentId: agent.id, skillId: skill.id, resource: d.resource, action: d.action },
        },
      });
      if (!permission) problems.push(`${label}: the production principal has no permission for it`);
      else if (permission.category !== d.category) problems.push(`${label}: permission category ${permission.category} does not match ${d.category}`);
      else if (permission.state === "DENIED") problems.push(`${label}: the production principal's permission is DENIED`);
    }
  }
  if (problems.length) throw new Error(`Action registry is inconsistent:\n - ${problems.join("\n - ")}`);
}

/** The single production principal: the configured Angel / SYSTEM principal. */
export function configuredProductionPrincipalId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.ANGEL_OS_SYSTEM_PRINCIPAL_ID;
  if (!id) throw new Error("ANGEL_OS_SYSTEM_PRINCIPAL_ID must be set: it identifies the production principal whose permissions are verified at startup.");
  return id;
}
