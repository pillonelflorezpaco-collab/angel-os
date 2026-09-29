import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { setPermission } from "../gateway/permissions/index.js";
import {
  decideApproval,
  createApprovalRequest,
  ApprovalOwnershipError,
} from "../gateway/index.js";
import { LocalMemoryProvider } from "../memory/local/index.js";
import { MemoryNotFoundError } from "../memory/types/index.js";
import { createTask, listTasks } from "../skills/system/tasks.js";
import { createReminder, listReminders } from "../skills/system/tasks.js";
import { RESOURCE as TASKS_RESOURCE, SKILL_KEY as TASKS_SKILL } from "../skills/system/tasks.js";
import { queryDecisions, RESOURCE as DECISIONS_RESOURCE, SKILL_KEY as DECISIONS_SKILL } from "../skills/system/decisions.js";

/**
 * Proves principal isolation is real, not merely theoretical — the whole
 * point of the audit's two-principal requirement. Every case here creates
 * TWO principals sharing the SAME agent/skill registry rows (as real
 * principals would) and asserts one cannot read, write, or decide the
 * other's data.
 */
describe("two-principal isolation", () => {
  const provider = new LocalMemoryProvider();
  let principalA: string;
  let principalB: string;
  const agentKey = "test-two-principal-agent";
  let agentId: string;

  beforeAll(async () => {
    const db = getDb();

    const a = await db.principal.create({ data: { name: "Principal A" } });
    const b = await db.principal.create({ data: { name: "Principal B" } });
    principalA = a.id;
    principalB = b.id;

    const agent = await db.agent.upsert({
      where: { key: agentKey },
      update: {},
      create: { key: agentKey, name: "Two-Principal Test Agent" },
    });
    agentId = agent.id;

    await db.skill.upsert({
      where: { key: TASKS_SKILL },
      update: {},
      create: { key: TASKS_SKILL, name: "System Tasks" },
    });
    await db.skill.upsert({
      where: { key: DECISIONS_SKILL },
      update: {},
      create: { key: DECISIONS_SKILL, name: "System Decisions" },
    });

    for (const principalId of [principalA, principalB]) {
      for (const action of ["READ", "CREATE_TASK", "CREATE_REMINDER"] as const) {
        await setPermission({
          principalId,
          agentKey,
          skillKey: TASKS_SKILL,
          resource: TASKS_RESOURCE,
          action,
          category: action === "READ" ? "READ" : "WRITE",
          state: "ALLOWED",
        });
      }
      await setPermission({
        principalId,
        agentKey,
        skillKey: DECISIONS_SKILL,
        resource: DECISIONS_RESOURCE,
        action: "DECISION_READ",
        category: "READ",
        state: "ALLOWED",
      });
    }
  });

  afterAll(async () => {
    const db = getDb();
    await db.principal.delete({ where: { id: principalA } }).catch(() => undefined);
    await db.principal.delete({ where: { id: principalB } }).catch(() => undefined);
    await db.agent.delete({ where: { id: agentId } }).catch(() => undefined);
    await disconnectDb();
  });

  describe("memory", () => {
    it("A can read, update, delete, and confirm A's own memory", async () => {
      const memory = await provider.addMemory({
        principalId: principalA,
        type: "INFERENCE",
        content: "A's own inference",
        source: "test",
      });

      const found = await provider.searchMemory({ principalId: principalA, query: "A's own inference" });
      expect(found.some((m) => m.id === memory.id)).toBe(true);

      const updated = await provider.updateMemory(principalA, memory.id, { content: "A's updated content" });
      expect(updated.content).toBe("A's updated content");

      const confirmed = await provider.confirmMemory(principalA, memory.id);
      expect(confirmed.status).toBe("ACTIVE");

      await provider.deleteMemory(principalA, memory.id);
      const afterDelete = await provider.searchMemory({ principalId: principalA, query: "A's updated content" });
      expect(afterDelete.find((m) => m.id === memory.id)).toBeUndefined();
    });

    it("A cannot read B's memory via search (scoped by principalId)", async () => {
      const bMemory = await provider.addMemory({
        principalId: principalB,
        type: "FACT",
        content: "B's private fact about their finances",
        source: "test",
      });
      const asA = await provider.searchMemory({ principalId: principalA, query: "B's private fact" });
      expect(asA.find((m) => m.id === bMemory.id)).toBeUndefined();
    });

    it("A cannot update B's memory by id", async () => {
      const bMemory = await provider.addMemory({
        principalId: principalB,
        type: "FACT",
        content: "B's memory to protect from update",
        source: "test",
      });
      await expect(
        provider.updateMemory(principalA, bMemory.id, { content: "tampered by A" })
      ).rejects.toThrow(MemoryNotFoundError);

      // Prove it was NOT modified.
      const stillB = await provider.searchMemory({ principalId: principalB, query: "B's memory to protect" });
      expect(stillB.some((m) => m.id === bMemory.id)).toBe(true);
    });

    it("A cannot delete B's memory by id", async () => {
      const bMemory = await provider.addMemory({
        principalId: principalB,
        type: "FACT",
        content: "B's memory to protect from deletion",
        source: "test",
      });
      await expect(provider.deleteMemory(principalA, bMemory.id)).rejects.toThrow(MemoryNotFoundError);

      const stillThere = await provider.searchMemory({
        principalId: principalB,
        query: "B's memory to protect from deletion",
      });
      expect(stillThere.some((m) => m.id === bMemory.id)).toBe(true);
    });

    it("A cannot confirm B's inference by id", async () => {
      const bMemory = await provider.addMemory({
        principalId: principalB,
        type: "INFERENCE",
        content: "B's inference to protect from confirmation",
        source: "test",
      });
      expect(bMemory.status).toBe("UNCONFIRMED");

      await expect(provider.confirmMemory(principalA, bMemory.id)).rejects.toThrow(MemoryNotFoundError);

      const stillUnconfirmed = await provider.searchMemory({
        principalId: principalB,
        query: "B's inference to protect",
      });
      expect(stillUnconfirmed.find((m) => m.id === bMemory.id)?.status).toBe("UNCONFIRMED");
    });
  });

  describe("approvals", () => {
    it("A can decide A's own approval", async () => {
      const approval = await createApprovalRequest({
        principalId: principalA,
        agentKey,
        skillKey: TASKS_SKILL,
        resource: "test:approval-a",
        action: "SOME_ACTION",
        parameters: {},
      });
      const decided = await decideApproval(principalA, approval.id, "APPROVED", "test");
      expect(decided.status).toBe("APPROVED");
    });

    it("B cannot decide A's approval", async () => {
      const approval = await createApprovalRequest({
        principalId: principalA,
        agentKey,
        skillKey: TASKS_SKILL,
        resource: "test:approval-a-2",
        action: "SOME_ACTION",
        parameters: {},
      });

      await expect(decideApproval(principalB, approval.id, "APPROVED", "test")).rejects.toThrow(
        ApprovalOwnershipError
      );

      // Prove it's still PENDING — B's attempt did not mutate it.
      const db = getDb();
      const stillPending = await db.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
      expect(stillPending.status).toBe("PENDING");
    });

    it("A cannot decide B's approval", async () => {
      const approval = await createApprovalRequest({
        principalId: principalB,
        agentKey,
        skillKey: TASKS_SKILL,
        resource: "test:approval-b",
        action: "SOME_ACTION",
        parameters: {},
      });

      await expect(decideApproval(principalA, approval.id, "REJECTED", "test")).rejects.toThrow(
        ApprovalOwnershipError
      );

      const db = getDb();
      const stillPending = await db.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } });
      expect(stillPending.status).toBe("PENDING");
    });
  });

  describe("permissions", () => {
    it("setting A's permission does not affect B's permission for the same skill/resource/action", async () => {
      await setPermission({
        principalId: principalA,
        agentKey,
        skillKey: TASKS_SKILL,
        resource: "test:shared-resource",
        action: "SENSITIVE_ACTION",
        category: "EXECUTE",
        state: "ALLOWED",
      });
      // B never had this permission set — must remain DENIED (fail closed),
      // proving A's grant is scoped to A and doesn't leak to B.
      const db = getDb();
      const bPermission = await db.permission.findFirst({
        where: {
          principalId: principalB,
          agentId,
          resource: "test:shared-resource",
          action: "SENSITIVE_ACTION",
        },
      });
      expect(bPermission).toBeNull();
    });
  });

  describe("tasks", () => {
    it("A cannot see B's tasks through listTasks", async () => {
      await createTask({ principalId: principalB, agentKey, title: "B's private task" });
      const aResult = await listTasks({ principalId: principalA, agentKey });
      expect(aResult.status).toBe("EXECUTED");
      const aTasks = aResult.data as { title: string }[];
      expect(aTasks.some((t) => t.title === "B's private task")).toBe(false);
    });
  });

  describe("reminders", () => {
    it("A cannot see B's reminders through listReminders", async () => {
      await createReminder({
        principalId: principalB,
        agentKey,
        message: "B's private reminder",
        remindAt: new Date(Date.now() + 60_000),
      });
      const aResult = await listReminders({ principalId: principalA, agentKey });
      expect(aResult.status).toBe("EXECUTED");
      const aReminders = aResult.data as { message: string }[];
      expect(aReminders.some((r) => r.message === "B's private reminder")).toBe(false);
    });
  });

  describe("decisions", () => {
    it("A cannot see B's decisions through queryDecisions", async () => {
      const db = getDb();
      await db.decision.create({
        data: {
          principalId: principalB,
          title: "B's confidential decision about salary",
          decision: "Give myself a raise",
        },
      });
      const aResult = await queryDecisions({ principalId: principalA, agentKey, topic: "salary" });
      expect(aResult.status).toBe("EXECUTED");
      const aDecisions = aResult.data as { title: string }[];
      expect(aDecisions.some((d) => d.title.includes("B's confidential"))).toBe(false);
    });
  });
});
