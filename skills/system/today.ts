import { gatewayExecute } from "../../gateway/index.js";
import { now } from "../../gateway/clock.js";
import { assertExplicitIdentity, type IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";
import { JARVIS_AGENT_KEY } from "../agent.js";
import { readFutureOverview } from "./future.js";
import { readExperiments, readObjectives, readLearningOverview } from "./learning.js";
import { listDecisionRecords } from "./decisions.js";
import { listTasks, listReminders } from "./tasks.js";
import { buildLoops, type LoopInput } from "../../progress/loops.js";
import * as progress from "../../progress/store.js";

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
    const [tasks, reminders, decisions, future, experiments, objectives, learning] = await Promise.all([
      listTasks(who, { agentKey }), listReminders(who, { agentKey }), listDecisionRecords(who, { agentKey, dueForReview: true }), readFutureOverview(who, { agentKey }),
      readExperiments(who, { agentKey }), readObjectives(who, { agentKey }), readLearningOverview(who, { agentKey, now: at }),
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
