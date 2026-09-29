import { identityFor } from "./helpers/fakeActions.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { parseIntent } from "../core/router/index.js";
import { JarvisCore, JARVIS_AGENT_KEY } from "../core/index.js";
import { SKILL_KEY as TASKS_SKILL, RESOURCE as TASKS_RESOURCE } from "../skills/system/tasks.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";

/** Regression for audit finding F4: "What are my reminders?" returned tasks. */
describe("reminder query routing", () => {
  const reminderPhrasings = ["What are my reminders?", "Show my reminders", "What reminders do I have?", "List my reminders"];
  const taskPhrasings = ["What are my tasks?", "what are my current tasks", "List my tasks"];

  it.each(reminderPhrasings)("routes %j to reminder.list", (input) => {
    expect(parseIntent(input).name).toBe("reminder.list");
  });

  it.each(taskPhrasings)("still routes %j to task.list", (input) => {
    expect(parseIntent(input).name).toBe("task.list");
  });

  describe("end to end", () => {
    let principalId: string;

    beforeAll(async () => {
      principalId = (await createPrincipal("Reminder Routing Principal")).id;
      await grant(principalId, JARVIS_AGENT_KEY, TASKS_SKILL, TASKS_RESOURCE, "READ", "READ");
      await getDb().task.create({ data: { principalId, title: "routing-only-task" } });
      await getDb().reminder.create({
        data: { principalId, message: "routing-only-reminder", remindAt: new Date(Date.now() + 3600_000) },
      });
    });

    afterAll(async () => {
      await deletePrincipal(principalId);
      await disconnectDb();
    });

    it.each(reminderPhrasings)("%j returns reminders, never tasks", async (input) => {
      const result = await new JarvisCore().handle({ principalId, identity: identityFor(principalId), input });
      expect(result.status).toBe("EXECUTED");
      const items = result.data as Record<string, unknown>[];
      expect(items.map((i) => i.message)).toContain("routing-only-reminder");
      expect(items.every((i) => "remindAt" in i)).toBe(true);
      expect(items.some((i) => i.title === "routing-only-task")).toBe(false);
    });

    it("the task query still returns tasks", async () => {
      const result = await new JarvisCore().handle({ principalId, identity: identityFor(principalId), input: "What are my tasks?" });
      const items = result.data as Record<string, unknown>[];
      expect(items.map((i) => i.title)).toContain("routing-only-task");
    });
  });
});
