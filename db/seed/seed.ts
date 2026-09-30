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

  const knowledgeSkill = await db.skill.upsert({
    where: { key: "system.knowledge" },
    update: {},
    create: { key: "system.knowledge", name: "System Knowledge", description: "Read the curated Markdown knowledge base (READ only, gateway-mediated)." },
  });

  const lifeSkill = await db.skill.upsert({
    where: { key: "system.life" },
    update: {},
    create: { key: "system.life", name: "System Life", description: "Vision, goals, projects, quests, people and their links." },
  });

  const futureSkill = await db.skill.upsert({
    where: { key: "system.future" },
    update: {},
    create: { key: "system.future", name: "System Future Self", description: "Aspirations (current, gap, desired, next) with evidence-based metrics." },
  });

  const learningSkill = await db.skill.upsert({
    where: { key: "system.learning" },
    update: {},
    create: { key: "system.learning", name: "System Learning Lab", description: "Learning topics, study sessions and recall cards." },
  });

  const captureSkill = await db.skill.upsert({
    where: { key: "system.capture" },
    update: {},
    create: { key: "system.capture", name: "System Capture", description: "Draft proposals from a sentence; nothing is saved until the owner confirms." },
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
    // Memory authority is split (BUILD #8): create is LOW risk; update, confirm
    // and delete are SENSITIVE and always need approval (policy enforces it
    // whatever this row says; APPROVAL_REQUIRED documents the intent).
    { resource: "angel:memory", action: "MEMORY_CREATE", category: "WRITE", state: "ALLOWED", skillId: memorySkill.id },
    { resource: "angel:memory", action: "MEMORY_UPDATE", category: "WRITE", state: "APPROVAL_REQUIRED", skillId: memorySkill.id },
    { resource: "angel:memory", action: "MEMORY_CONFIRM", category: "WRITE", state: "APPROVAL_REQUIRED", skillId: memorySkill.id },
    { resource: "angel:memory", action: "MEMORY_DELETE", category: "WRITE", state: "APPROVAL_REQUIRED", skillId: memorySkill.id },
    { resource: "angel:memory", action: "MEMORY_RETRACT", category: "WRITE", state: "APPROVAL_REQUIRED", skillId: memorySkill.id },
    { resource: "angel:knowledge", action: "KNOWLEDGE_READ", category: "READ", state: "ALLOWED", skillId: knowledgeSkill.id },
    { resource: "angel:knowledge", action: "KNOWLEDGE_INGEST", category: "WRITE", state: "ALLOWED", skillId: knowledgeSkill.id },
    { resource: "angel:knowledge", action: "KNOWLEDGE_ADD", category: "WRITE", state: "ALLOWED", skillId: knowledgeSkill.id },
    { resource: "angel:knowledge", action: "KNOWLEDGE_RELATE", category: "WRITE", state: "ALLOWED", skillId: knowledgeSkill.id },
    { resource: "angel:knowledge", action: "KNOWLEDGE_RETRACT", category: "WRITE", state: "ALLOWED", skillId: knowledgeSkill.id },
    { resource: "angel:knowledge", action: "KNOWLEDGE_DELETE_SOURCE", category: "WRITE", state: "APPROVAL_REQUIRED", skillId: knowledgeSkill.id },
    { resource: "angel:life", action: "LIFE_READ", category: "READ", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "VISION_CREATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "VISION_UPDATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "VISION_ARCHIVE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "GOAL_CREATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "GOAL_UPDATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "GOAL_ACHIEVE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "GOAL_ABANDON", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PROJECT_CREATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PROJECT_UPDATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PROJECT_SET_STATUS", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PROJECT_LINK_PERSON", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PROJECT_UNLINK_PERSON", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PROJECT_LINK_KNOWLEDGE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PROJECT_UNLINK_KNOWLEDGE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "QUEST_CREATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "QUEST_UPDATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "QUEST_START", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "QUEST_COMPLETE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "QUEST_ABANDON", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PERSON_CREATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PERSON_UPDATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "PERSON_DELETE", category: "WRITE", state: "APPROVAL_REQUIRED", skillId: lifeSkill.id },
    { resource: "angel:tasks", action: "TASK_UPDATE", category: "WRITE", state: "ALLOWED", skillId: tasksSkill.id },
    { resource: "angel:tasks", action: "TASK_COMPLETE", category: "WRITE", state: "ALLOWED", skillId: tasksSkill.id },
    { resource: "angel:tasks", action: "TASK_CANCEL", category: "WRITE", state: "ALLOWED", skillId: tasksSkill.id },
    { resource: "angel:life", action: "RESULT_RECORD", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:life", action: "REVIEW_CREATE", category: "WRITE", state: "ALLOWED", skillId: lifeSkill.id },
    { resource: "angel:decisions", action: "DECISION_RECORD", category: "WRITE", state: "ALLOWED", skillId: decisionsSkill.id },
    { resource: "angel:decisions", action: "DECISION_REVIEW", category: "WRITE", state: "ALLOWED", skillId: decisionsSkill.id },
    { resource: "angel:future", action: "FUTURE_READ", category: "READ", state: "ALLOWED", skillId: futureSkill.id },
    { resource: "angel:future", action: "ASPIRATION_CREATE", category: "WRITE", state: "ALLOWED", skillId: futureSkill.id },
    { resource: "angel:future", action: "ASPIRATION_UPDATE", category: "WRITE", state: "ALLOWED", skillId: futureSkill.id },
    { resource: "angel:future", action: "ASPIRATION_ACHIEVE", category: "WRITE", state: "ALLOWED", skillId: futureSkill.id },
    { resource: "angel:future", action: "ASPIRATION_RELEASE", category: "WRITE", state: "ALLOWED", skillId: futureSkill.id },
    { resource: "angel:future", action: "METRIC_CREATE", category: "WRITE", state: "ALLOWED", skillId: futureSkill.id },
    { resource: "angel:future", action: "METRIC_READING_RECORD", category: "WRITE", state: "ALLOWED", skillId: futureSkill.id },
    { resource: "angel:future", action: "ASPIRATION_STATE_RECORD", category: "WRITE", state: "ALLOWED", skillId: futureSkill.id },
    { resource: "angel:future", action: "EVIDENCE_ATTACH", category: "WRITE", state: "ALLOWED", skillId: futureSkill.id },
    { resource: "angel:learning", action: "LEARNING_READ", category: "READ", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "TOPIC_CREATE", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "TOPIC_UPDATE", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "TOPIC_SET_STATUS", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "SESSION_LOG", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "CARD_CREATE", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "CARD_REVIEW", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "CARD_RETIRE", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "OBJECTIVE_CREATE", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "OBJECTIVE_CLOSE", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "EXPERIMENT_CREATE", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "EXPERIMENT_OBSERVE", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "EXPERIMENT_TRANSITION", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    { resource: "angel:learning", action: "LESSON_RECORD", category: "WRITE", state: "ALLOWED", skillId: learningSkill.id },
    // system.capture — holding a DRAFT (interpret / confirm / cancel). Draft bookkeeping only; every domain write inside a confirmed
    // draft is its own ActionDefinition with its own permission row above.
    { resource: "angel:capture", action: "CAPTURE_INTERPRET", category: "READ", state: "ALLOWED", skillId: captureSkill.id },
    { resource: "angel:capture", action: "CAPTURE_DECIDE", category: "READ", state: "ALLOWED", skillId: captureSkill.id },
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
    `Seeded principal ${principal.id}, agent ${agent.key}, skills: ${[tasksSkill, memorySkill, decisionsSkill, activitySkill, knowledgeSkill, lifeSkill, futureSkill, learningSkill, captureSkill, calendarSkill, gmailSkill].map((s) => s.key).join(", ")}`
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
