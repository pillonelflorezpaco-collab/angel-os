import type { ActionCategory, PermissionState } from "@prisma/client";
import { getDb } from "../../db/client/index.js";

export interface PermissionCheckInput {
  principalId: string;
  agentKey: string;
  skillKey: string;
  resource: string;
  action: string;
}

export interface PermissionCheckResult {
  state: PermissionState;
  category: ActionCategory | null;
  permissionId: string | null;
}

/**
 * The single gate every action must pass through before it touches
 * anything. Looks up the (principal, agent, skill, resource, action)
 * permission row. No matching row = DENIED by default (fail closed, never
 * fail open) — a skill must have an explicit permission row to act at all.
 */
export async function checkPermission(
  input: PermissionCheckInput
): Promise<PermissionCheckResult> {
  const db = getDb();

  const agent = await db.agent.findUnique({ where: { key: input.agentKey } });
  const skill = await db.skill.findUnique({ where: { key: input.skillKey } });

  if (!agent || !skill) {
    return { state: "DENIED", category: null, permissionId: null };
  }

  const permission = await db.permission.findUnique({
    where: {
      principalId_agentId_skillId_resource_action: {
        principalId: input.principalId,
        agentId: agent.id,
        skillId: skill.id,
        resource: input.resource,
        action: input.action,
      },
    },
  });

  if (!permission) {
    return { state: "DENIED", category: null, permissionId: null };
  }

  return {
    state: permission.state,
    category: permission.category,
    permissionId: permission.id,
  };
}

export interface SetPermissionInput {
  principalId: string;
  agentKey: string;
  skillKey: string;
  resource: string;
  action: string;
  category: ActionCategory;
  state: PermissionState;
}

/**
 * Grants, denies, or marks approval-required for an (agent, skill, resource,
 * action) tuple. Fixes the audit finding that permission changes produced
 * no audit event: the upsert and the audit write happen inside one
 * `$transaction`, so a permission can never change without a corresponding
 * PERMISSION_GRANTED/PERMISSION_REVOKED record, and a failed audit write
 * rolls back the permission change (never an inconsistent half-applied
 * state).
 */
export async function setPermission(input: SetPermissionInput, source = "gateway") {
  const db = getDb();

  return db.$transaction(async (tx) => {
    const agent = await tx.agent.findUniqueOrThrow({ where: { key: input.agentKey } });
    const skill = await tx.skill.findUniqueOrThrow({ where: { key: input.skillKey } });

    const previous = await tx.permission.findUnique({
      where: {
        principalId_agentId_skillId_resource_action: {
          principalId: input.principalId,
          agentId: agent.id,
          skillId: skill.id,
          resource: input.resource,
          action: input.action,
        },
      },
    });

    const permission = await tx.permission.upsert({
      where: {
        principalId_agentId_skillId_resource_action: {
          principalId: input.principalId,
          agentId: agent.id,
          skillId: skill.id,
          resource: input.resource,
          action: input.action,
        },
      },
      create: {
        principalId: input.principalId,
        agentId: agent.id,
        skillId: skill.id,
        resource: input.resource,
        action: input.action,
        category: input.category,
        state: input.state,
      },
      update: {
        category: input.category,
        state: input.state,
      },
    });

    // ALLOWED (and APPROVAL_REQUIRED, since it's a grant of conditional
    // access rather than an outright refusal) are logged as a grant;
    // DENIED is logged as a revoke. Never log secrets — only identifiers
    // and states.
    const eventType = input.state === "DENIED" ? "PERMISSION_REVOKED" : "PERMISSION_GRANTED";

    await tx.auditLog.create({
      data: {
        principalId: input.principalId,
        agentId: agent.id,
        eventType,
        resource: input.resource,
        action: input.action,
        result: "SUCCESS",
        source,
        metadata: {
          agentKey: input.agentKey,
          skillKey: input.skillKey,
          previousState: previous?.state ?? null,
          newState: input.state,
        },
      },
    });

    return permission;
  });
}
