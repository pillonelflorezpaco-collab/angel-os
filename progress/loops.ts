// OPEN LOOPS: "what matters" assembled ONLY from things that already exist and are still open. Each item says what it is and why it is listed;
// nothing is scored, ranked by a hidden formula, or invented. Order inside a group is by date, then title. Pure: no reads, no clock.

export interface LoopInput {
  now: Date;
  tasks: { id: string; title: string; status: string; dueAt: Date | null }[];
  reminders: { id: string; message: string; remindAt: Date; status: string }[];
  decisionsDue: { id: string; title: string; reviewAt: Date | null }[];
  aspirations: { id: string; title: string; nextTask: { id: string; title: string; status: string } | null; nextQuest: { id: string; title: string; status: string } | null }[];
  experiments: { id: string; hypothesis: string; status: string }[];
  objectives: { id: string; title: string; status: string; evidence: { total: number } }[];
  cardsDue: number;
}

export type LoopGroup = "NOW" | "NEXT" | "OPEN";
export interface Loop { kind: string; group: LoopGroup; title: string; why: string; when: string | null; ref: { type: string; id: string } | null }

const DAY = 86_400_000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
export const MAX_PER_GROUP = 8;

export function buildLoops(i: LoopInput): { NOW: Loop[]; NEXT: Loop[]; OPEN: Loop[] } {
  const now = i.now.getTime();
  const out: Loop[] = [];
  const openTask = (t: { status: string }) => t.status === "TODO" || t.status === "IN_PROGRESS";
  const nextTaskIds = new Set(i.aspirations.flatMap((a) => (a.nextTask && openTask(a.nextTask) ? [a.nextTask.id] : [])));

  for (const t of i.tasks.filter(openTask)) {
    if (t.dueAt && t.dueAt.getTime() < now) out.push({ kind: "TASK", group: "NOW", title: t.title, why: "This task is overdue.", when: iso(t.dueAt), ref: { type: "task", id: t.id } });
    else if (t.dueAt && t.dueAt.getTime() <= now + DAY) out.push({ kind: "TASK", group: "NOW", title: t.title, why: "This task is due within 24 hours.", when: iso(t.dueAt), ref: { type: "task", id: t.id } });
    else if (t.dueAt && t.dueAt.getTime() <= now + 7 * DAY) out.push({ kind: "TASK", group: "NEXT", title: t.title, why: "This task is due within 7 days.", when: iso(t.dueAt), ref: { type: "task", id: t.id } });
    else if (!nextTaskIds.has(t.id)) out.push({ kind: "TASK", group: "OPEN", title: t.title, why: t.dueAt ? "An open task with a later due date." : "An open task with no due date.", when: iso(t.dueAt), ref: { type: "task", id: t.id } });
  }
  for (const r of i.reminders) {
    if (r.status === "PENDING" && r.remindAt.getTime() <= now + DAY) out.push({ kind: "REMINDER", group: "NOW", title: r.message, why: r.remindAt.getTime() < now ? "A reminder that was due and hasn't been delivered." : "A reminder due within 24 hours.", when: iso(r.remindAt), ref: { type: "reminder", id: r.id } });
  }
  for (const d of i.decisionsDue) out.push({ kind: "DECISION_REVIEW", group: "NOW", title: d.title, why: "The look-back date for this decision has passed and it has no look-back yet.", when: iso(d.reviewAt), ref: { type: "decision", id: d.id } });
  if (i.cardsDue > 0) out.push({ kind: "CARDS", group: "NOW", title: `${i.cardsDue} recall card${i.cardsDue === 1 ? "" : "s"} due`, why: "Cards scheduled for review have come due.", when: null, ref: null });

  for (const a of i.aspirations) {
    if (a.nextTask && openTask(a.nextTask)) out.push({ kind: "NEXT_ACTION", group: "NEXT", title: a.nextTask.title, why: `The next action you set for “${a.title}”.`, when: null, ref: { type: "task", id: a.nextTask.id } });
    else if (a.nextQuest && (a.nextQuest.status === "PLANNED" || a.nextQuest.status === "ACTIVE")) out.push({ kind: "NEXT_ACTION", group: "NEXT", title: a.nextQuest.title, why: `The next quest you set for “${a.title}”.`, when: null, ref: { type: "quest", id: a.nextQuest.id } });
    else out.push({ kind: "NO_NEXT_ACTION", group: "OPEN", title: a.title, why: "This aspiration has no open next action linked.", when: null, ref: { type: "aspiration", id: a.id } });
  }
  for (const e of i.experiments.filter((x) => x.status !== "CONFIRMED" && x.status !== "REJECTED")) out.push({ kind: "EXPERIMENT", group: "OPEN", title: e.hypothesis, why: `An experiment that hasn't reached a verdict (status: ${e.status.toLowerCase()}).`, when: null, ref: { type: "experiment", id: e.id } });
  for (const o of i.objectives.filter((x) => x.status === "ACTIVE")) out.push({ kind: "OBJECTIVE", group: "OPEN", title: o.title, why: o.evidence.total ? `A learning objective not yet met (${o.evidence.total} evidence link${o.evidence.total === 1 ? "" : "s"}).` : "A learning objective not yet met, with no evidence recorded.", when: null, ref: { type: "objective", id: o.id } });

  const byWhen = (a: Loop, b: Loop) => (a.when ?? "9999").localeCompare(b.when ?? "9999") || a.title.localeCompare(b.title);
  const pick = (g: LoopGroup) => out.filter((l) => l.group === g).sort(byWhen).slice(0, MAX_PER_GROUP);
  return { NOW: pick("NOW"), NEXT: pick("NEXT"), OPEN: pick("OPEN") };
}
