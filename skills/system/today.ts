import { gatewayExecute } from "../../gateway/index.js";
import { now } from "../../gateway/clock.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";
import { JARVIS_AGENT_KEY } from "../agent.js";
import { readFutureOverview } from "./future.js";
import { readExperiments, readObjectives, readLearningOverview } from "./learning.js";
import { listDecisionRecords } from "./decisions.js";
import { listTasks, listReminders } from "./tasks.js";
import { readTodayPlan } from "./routines.js";
import { buildLoops, type LoopInput } from "../../progress/loops.js";
import * as progress from "../../progress/store.js";
import { buildCalendar, LEVELS } from "../../progress/calendar.js";
import { buildTimeline, buildMap, type StateRow, type MapGoal, type MapProject } from "../../progress/timeline.js";
import { readLifeOverview } from "./life.js";
import { readStateTimeline } from "./future.js";

// "What matters": open loops assembled from what already exists, and factual badges. Both are READ-lane. Open loops compose the other skills'
// own permission-checked reads, so a domain the caller can't read simply contributes nothing and is named in `withheld`.

export const SKILL_KEY = "system.today";
export const RESOURCE = "angel:today";
export const LOOPS_ACTION = "TODAY_READ";
export const PROGRESS_ACTION = "PROGRESS_READ";
const SOURCE = "skill.system.today";
const NO_IDENTITY: Result = { status: "FAILED", message: "I can't do that without knowing who you are." };

const rows = <T>(r: Result): T[] | null => (r.status === "EXECUTED" && Array.isArray(r.data) ? (r.data as T[]) : null);
const asDate = (v: unknown) => (v ? new Date(v as string | Date) : null);

export async function readOpenLoops(identity: IdentityContext): Promise<Result> {
  let who: IdentityContext;
  try { who = assertExplicitIdentity(identity); } catch { return NO_IDENTITY; }
  const agentKey = JARVIS_AGENT_KEY;
  return gatewayExecute({ principalId: who.principalId, agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: LOOPS_ACTION, parameters: { op: "loops" } }, async () => {
    const at = now();
    const [tasks, reminders, decisions, future, experiments, objectives, learning, plan] = await Promise.all([
      listTasks(who, { agentKey }), listReminders(who, { agentKey }), listDecisionRecords(who, { agentKey, dueForReview: true }), readFutureOverview(who, { agentKey }),
      readExperiments(who, { agentKey }), readObjectives(who, { agentKey }), readLearningOverview(who, { agentKey, now: at }), readTodayPlan(who, { agentKey }),
    ]);
    const withheld: string[] = [];
    const use = <T>(name: string, r: Result): T[] => { const v = rows<T>(r); if (!v) withheld.push(name); return v ?? []; };
    const input: LoopInput = {
      now: at,
      tasks: use<{ id: string; title: string; status: string; dueAt: Date | null }>("tasks", tasks).map((t) => ({ ...t, dueAt: asDate(t.dueAt) })),
      reminders: use<{ id: string; message: string; remindAt: Date; status: string }>("reminders", reminders).map((r) => ({ ...r, remindAt: new Date(r.remindAt) })),
      decisionsDue: use<{ id: string; title: string; reviewAt: Date | null }>("decisions", decisions).map((d) => ({ ...d, reviewAt: asDate(d.reviewAt) })),
      aspirations: use<LoopInput["aspirations"][number]>("future self", future),
      experiments: use<LoopInput["experiments"][number]>("experiments", experiments),
      objectives: use<LoopInput["objectives"][number]>("objectives", objectives),
      cardsDue: use<{ due: number }>("learning", learning).reduce((n, t) => n + (t.due ?? 0), 0),
      routines: plan.status === "EXECUTED" ? (plan.data as { items: LoopInput["routines"] }).items : (withheld.push("routines"), []),
    };
    return { generatedAt: at.toISOString(), ...buildLoops(input), withheld, note: "Everything listed already exists and is still open. Nothing is scored or invented." };
  }, SOURCE);
}

export async function readBadges(identity: IdentityContext): Promise<Result> {
  let who: IdentityContext;
  try { who = assertExplicitIdentity(identity); } catch { return NO_IDENTITY; }
  return gatewayExecute({ principalId: who.principalId, agentKey: JARVIS_AGENT_KEY, skillKey: SKILL_KEY, resource: RESOURCE, action: PROGRESS_ACTION, parameters: { op: "badges" } }, () => progress.badgeReport(who.principalId, now()), SOURCE);
}

/** Plain-language text for a chat surface (Jarvis Core). */
export function formatLoops(d: { NOW: { title: string; why: string }[]; NEXT: { title: string; why: string }[]; OPEN: { title: string; why: string }[]; withheld: string[] }): string {
  const lines: string[] = [];
  const block = (label: string, items: { title: string; why: string }[]) => { if (items.length) { lines.push(`${label}:`); for (const l of items) lines.push(`• ${l.title} — ${l.why}`); } };
  block("Due now", d.NOW); block("Coming up", d.NEXT); block("Still open", d.OPEN);
  if (!lines.length) lines.push("Nothing open is waiting on you right now.");
  if (d.withheld.length) lines.push(`(Not shown — no access: ${d.withheld.join(", ")}.)`);
  return lines.join("\n");
}

export const CALENDAR_DAYS = 84;
export const MAX_TIMELINES = 8;

/** Three honest pictures of what was recorded: an activity calendar, a Future Self timeline, and a goals-to-projects map. */
export async function readProgressOverview(identity: IdentityContext): Promise<Result> {
  let who: IdentityContext;
  try { who = assertExplicitIdentity(identity); } catch { return NO_IDENTITY; }
  const agentKey = JARVIS_AGENT_KEY;
  return gatewayExecute({ principalId: who.principalId, agentKey, skillKey: SKILL_KEY, resource: RESOURCE, action: PROGRESS_ACTION, parameters: { op: "overview" } }, async () => {
    const at = now();
    const withheld: string[] = [];
    const [cal, life, future] = await Promise.all([progress.calendarEvents(who.principalId, at, CALENDAR_DAYS), readLifeOverview(who, { agentKey }), readFutureOverview(who, { agentKey })]);
    const l = life.status === "EXECUTED" ? (life.data as { goals: MapGoal[]; projects: MapProject[] }) : (withheld.push("life"), { goals: [], projects: [] });
    const aspirations = future.status === "EXECUTED" ? (future.data as { id: string; title: string }[]).slice(0, MAX_TIMELINES) : (withheld.push("future self"), []);
    const withStates = await Promise.all(aspirations.map(async (a) => {
      const r = await readStateTimeline(who, { agentKey, aspirationId: a.id });
      return { id: a.id, title: a.title, states: r.status === "EXECUTED" ? (r.data as StateRow[]) : [] };
    }));
    return {
      generatedAt: at.toISOString(), timeZone: cal.timeZone, levels: LEVELS,
      calendar: buildCalendar(cal.events.map((e) => ({ occurredAt: new Date(e.occurredAt), type: e.type })), at, cal.timeZone, CALENDAR_DAYS),
      timeline: buildTimeline(withStates.map((a) => ({ ...a, states: a.states.map((s) => ({ ...s, createdAt: new Date(s.createdAt) })) })), at),
      map: buildMap(l.goals, l.projects), withheld,
      note: "These pictures only show what was recorded: real counts and real dates. Nothing is scored, averaged or projected.",
    };
  }, SOURCE);
}
