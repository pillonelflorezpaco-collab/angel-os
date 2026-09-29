import { getDb, disconnectDb } from "../client/index.js";

/**
 * Seeds the minimum registry data the application needs to function:
 * the Principal (Angel), the jarvis-core Agent, the system.tasks Skill,
 * and its permissions. Also seeds a couple of example permission rows on
 * a placeholder "communication.gmail" Skill registry entry — purely to
 * demonstrate the READ/WRITE/EXECUTE + ALLOWED/DENIED/APPROVAL_REQUIRED
 * model end to end. That skill is NOT implemented; see docs/ROADMAP.md.
 */
async function main() {
  const db = getDb();

  const principal = await db.principal.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    update: {},
    create: { id: "00000000-0000-0000-0000-000000000001", name: "Angel" },
  });

  const agent = await db.agent.upsert({
    where: { key: "jarvis-core" },
    update: {},
    create: { key: "jarvis-core", name: "Jarvis Core", description: "The orchestrating agent." },
  });

  const tasksSkill = await db.skill.upsert({
    where: { key: "system.tasks" },
    update: {},
    create: { key: "system.tasks", name: "System Tasks", description: "Tasks and reminders." },
  });

  const memorySkill = await db.skill.upsert({
    where: { key: "system.memory" },
    update: {},
    create: { key: "system.memory", name: "System Memory", description: "Long-term personal memory." },
  });

  const decisionsSkill = await db.skill.upsert({
    where: { key: "system.decisions" },
    update: {},
    create: { key: "system.decisions", name: "System Decisions", description: "Decision history." },
  });

  const activitySkill = await db.skill.upsert({
    where: { key: "system.activity" },
    update: {},
    create: { key: "system.activity", name: "System Activity", description: "Read the user-facing activity stream (life history)." },
  });

  const calendarSkill = await db.skill.upsert({
    where: { key: "integrations.calendar" },
    update: {},
    create: {
      key: "integrations.calendar",
      name: "Google Calendar (read-only)",
      description: "Read-only calendar access via the Google Calendar connector.",
    },
  });

  const gmailSkill = await db.skill.upsert({
    where: { key: "communication.gmail" },
    update: {},
    create: {
      key: "communication.gmail",
      name: "Gmail (registry placeholder, not implemented)",
      description: "Not implemented in v0.1. Exists only to demonstrate the permission model.",
      active: false,
    },
  });

  const permissions: {
    resource: string;
    action: string;
    category: "READ" | "WRITE" | "EXECUTE";
    state: "ALLOWED" | "DENIED" | "APPROVAL_REQUIRED";
    skillId: string;
  }[] = [
    { resource: "angel:tasks", action: "READ", category: "READ", state: "ALLOWED", skillId: tasksSkill.id },
    { resource: "angel:tasks", action: "CREATE_TASK", category: "WRITE", state: "ALLOWED", skillId: tasksSkill.id },
    {
      resource: "angel:tasks",
      action: "CREATE_REMINDER",
      category: "WRITE",
      state: "ALLOWED",
      skillId: tasksSkill.id,
    },
    // system.memory — the minimum needed for existing Jarvis Core behavior
    // ("remember that...", "what do i know about...") to keep working now
    // that it's routed through the gateway instead of bypassing it.
    { resource: "angel:memory", action: "MEMORY_READ", category: "READ", state: "ALLOWED", skillId: memorySkill.id },
    { resource: "angel:memory", action: "MEMORY_WRITE", category: "WRITE", state: "ALLOWED", skillId: memorySkill.id },
    // system.decisions — same rationale, for "what did i decide about...".
    {
      resource: "angel:decisions",
      action: "DECISION_READ",
      category: "READ",
      state: "ALLOWED",
      skillId: decisionsSkill.id,
    },
    // system.activity — reading the life-history stream ("What happened today?").
    { resource: "angel:activity", action: "ACTIVITY_READ", category: "READ", state: "ALLOWED", skillId: activitySkill.id },
    // integrations.calendar — the ONE permission this build seeds:
    // CALENDAR/READ. No WRITE or EXECUTE row is seeded for this skill —
    // their absence means DENIED by the gateway's fail-closed default,
    // which is exactly the point (Google Calendar connector reports no
    // calendar.write capability in this build either — see
    // connectors/google/calendarConnector.ts).
    { resource: "angel:calendar", action: "READ", category: "READ", state: "ALLOWED", skillId: calendarSkill.id },
    // Example only (gmail skill not implemented):
    { resource: "angel:gmail", action: "READ", category: "READ", state: "ALLOWED", skillId: gmailSkill.id },
    {
      resource: "angel:gmail",
      action: "SEND_EMAIL",
      category: "EXECUTE",
      state: "APPROVAL_REQUIRED",
      skillId: gmailSkill.id,
    },
    {
      resource: "angel:gmail",
      action: "DELETE_ALL",
      category: "EXECUTE",
      state: "DENIED",
      skillId: gmailSkill.id,
    },
  ];

  for (const p of permissions) {
    await db.permission.upsert({
      where: {
        principalId_agentId_skillId_resource_action: {
          principalId: principal.id,
          agentId: agent.id,
          skillId: p.skillId,
          resource: p.resource,
          action: p.action,
        },
      },
      update: { state: p.state, category: p.category },
      create: {
        principalId: principal.id,
        agentId: agent.id,
        skillId: p.skillId,
        resource: p.resource,
        action: p.action,
        category: p.category,
        state: p.state,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `Seeded principal ${principal.id}, agent ${agent.key}, skills: ${tasksSkill.key}, ${memorySkill.key}, ${decisionsSkill.key}, ${activitySkill.key}, ${calendarSkill.key}, ${gmailSkill.key}`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
  });
