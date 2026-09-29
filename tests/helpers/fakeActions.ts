import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../../db/client/index.js";
import { registerAction } from "../../gateway/actions/registry.js";
import { getActionDefinition } from "../../gateway/actions/registry.js";
import type { ExecutionContext } from "../../gateway/actions/types.js";
import { setPermission } from "../../gateway/permissions/index.js";
import { PublicError } from "../../core/errors.js";
import { createIdentity, type IdentityContext, type InterfaceSource } from "../../identity/index.js";

// Deterministic fake actions for the approval & execution engine. They have
// no external effect: each just records that it ran, with exactly what it
// was given, so tests can prove "approved action == executed action" and
// "ran exactly once".

export const FAKE_SKILL = "test.exec";
export const FAKE_AGENT = "test-exec-agent";
export const FAKE_RESOURCE = "test:exec";

export interface FakeCall {
  ctx: ExecutionContext;
  params: unknown;
}
export const calls: FakeCall[] = [];
export const resetCalls = () => { calls.length = 0; };

const messageSchema = z.object({ to: z.string().min(1), body: z.string(), tags: z.array(z.string()).optional() }).strict();

const base = { skillKey: FAKE_SKILL, resource: FAKE_RESOURCE, agentKey: FAKE_AGENT };

export const ACTIONS = {
  SEND: "FAKE_SEND", // EXECUTE / SENSITIVE
  FAIL: "FAKE_FAIL", // EXECUTE / SENSITIVE, throws
  LOW: "FAKE_LOW", // WRITE / LOW
  READ: "FAKE_READ", // READ / LOW
  DANGER: "FAKE_DANGER", // EXECUTE / DANGEROUS
} as const;

export function registerFakeActions(): void {
  if (getActionDefinition(FAKE_SKILL, ACTIONS.SEND)) return;
  registerAction({
    ...base, action: ACTIONS.SEND, category: "EXECUTE", risk: "SENSITIVE", schema: messageSchema,
    describe: (p) => `Send test message to ${p.to}`,
    execute: async (ctx, params) => { calls.push({ ctx, params }); return { delivered: true }; },
    successMessage: () => "Test message sent.",
  });
  registerAction({
    ...base, action: ACTIONS.FAIL, category: "EXECUTE", risk: "SENSITIVE", schema: messageSchema,
    describe: (p) => `Failing test action to ${p.to}`,
    execute: async (ctx, params) => { calls.push({ ctx, params }); throw new Error("connection to db://secret-host failed: password=hunter2"); },
  });
  registerAction({
    ...base, action: ACTIONS.LOW, category: "WRITE", risk: "LOW", schema: messageSchema,
    describe: (p) => `Low-risk note to ${p.to}`,
    execute: async (ctx, params) => { calls.push({ ctx, params }); return { ok: true }; },
    successMessage: () => "Note saved.",
  });
  registerAction({
    ...base, action: ACTIONS.READ, category: "READ", risk: "LOW", schema: z.object({}).strict(),
    describe: () => "Read test data",
    execute: async (ctx, params) => { calls.push({ ctx, params }); return { rows: 0 }; },
  });
  registerAction({
    ...base, action: ACTIONS.DANGER, category: "EXECUTE", risk: "DANGEROUS", schema: messageSchema,
    describe: (p) => `Dangerous test action to ${p.to}`,
    execute: async (ctx, params) => { calls.push({ ctx, params }); return { done: true }; },
  });
  registerAction({
    ...base, action: "FAKE_PUBLIC_FAIL", category: "EXECUTE", risk: "SENSITIVE", schema: messageSchema,
    describe: (p) => `Public-failure test action to ${p.to}`,
    execute: async () => { throw new PublicError("The test provider rejected that."); },
  });
}

/** Registry rows the permission table needs (idempotent). */
export async function ensureExecRegistry(): Promise<void> {
  const db = getDb();
  await db.agent.upsert({ where: { key: FAKE_AGENT }, update: {}, create: { key: FAKE_AGENT, name: "Test exec agent" } });
  await db.skill.upsert({ where: { key: FAKE_SKILL }, update: {}, create: { key: FAKE_SKILL, name: "Test exec skill" } });
}

const CATEGORY: Record<string, "READ" | "WRITE" | "EXECUTE"> = {
  FAKE_SEND: "EXECUTE", FAKE_FAIL: "EXECUTE", FAKE_LOW: "WRITE", FAKE_READ: "READ", FAKE_DANGER: "EXECUTE", FAKE_PUBLIC_FAIL: "EXECUTE",
};

export async function grantFake(principalId: string, action: string, state: "ALLOWED" | "DENIED" | "APPROVAL_REQUIRED" = "APPROVAL_REQUIRED") {
  await setPermission({ principalId, agentKey: FAKE_AGENT, skillKey: FAKE_SKILL, resource: FAKE_RESOURCE, action, category: CATEGORY[action], state });
}

export async function grantAllFake(principalId: string, state: "ALLOWED" | "APPROVAL_REQUIRED" = "APPROVAL_REQUIRED") {
  for (const a of Object.keys(CATEGORY)) await grantFake(principalId, a, state);
}

export function identityFor(principalId: string, source: InterfaceSource = "GUIDEHUB"): IdentityContext {
  return createIdentity({ principalId, interfaceSource: source, authMethod: source === "TELEGRAM" ? "external_identity" : "api_token", requestId: randomUUID() });
}

export const goodParams = { to: "alice@example.com", body: "hello" };

/**
 * Makes audit writes fail for the events `shouldFail` selects, for the duration of `fn`.
 * Swaps the Prisma delegate's method directly (vi.spyOn + restore breaks Prisma's proxy).
 */
export async function withAuditFailures<T>(shouldFail: (eventType: string) => boolean, fn: () => Promise<T>): Promise<T> {
  const delegate = getDb().auditLog as unknown as { create: (args: { data: { eventType: string } }) => Promise<unknown> };
  const original = delegate.create;
  delegate.create = function (args) {
    if (shouldFail(args.data.eventType)) return Promise.reject(new Error("audit store unavailable"));
    return original.call(delegate, args);
  };
  try {
    return await fn();
  } finally {
    delegate.create = original;
  }
}
