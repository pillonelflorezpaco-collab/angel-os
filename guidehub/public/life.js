import { HORIZONS, isTerminal, lifeOutcome, linkablePeople, projectTransitions, questTransitions, statusLabel, taskCountsLine, taskTransitions } from "./lib.js";
import { api, empty, h, mount, outcomeBox, section, state } from "./ui.js";
import { dateBit, formCard, guarded, okOrList, pill, run } from "./kit.js";

// Step 2: Life — visions, goals, projects, quests, tasks and people (docs/guidehub/cockpit-design.md).
// Every write is POST /api/actions/<skill>/<ACTION>; nothing here decides anything. Closing something is the owner's explicit act, closed items
// are read-only (no reopen control exists), and a 202 means "waiting for approval — nothing has changed yet".

let renderToken = 0; // a slow response for a screen the user already left must not paint over the current one
// ── Life overview ────────────────────────────────────────────────────────
export async function renderLife(view) {
  const token = ++renderToken;
  mount(view, h("p", { class: "muted", text: "Loading…" }));
  const [ov, hist, ppl] = await Promise.all([api("GET", "/api/life/overview"), api("GET", "/api/life/history"), api("GET", "/api/life/people")]);
  if (token !== renderToken || !state.active) return;
  if (ov.status !== 200 || ov.body?.status !== "EXECUTED") return mount(view, h("h1", { text: "Life" }), section("Life", outcomeBox(lifeOutcome(ov.status === 200 ? 403 : ov.status, ov.body))));
  const o = ov.body.data;
  const people = okOrList(ppl) ?? [];
  const history = hist.status === 200 && hist.body?.status === "EXECUTED" ? hist.body.data : null;
  const goalName = new Map(o.goals.map((g) => [g.id, g.title]));
  const projectName = new Map(o.projects.map((p) => [p.id, p.name]));
  const visionName = new Map(o.visions.map((v) => [v.id, v.title]));

  // Visions
  const visions = section("Vision",
    o.visions.length ? h("ul", { class: "list" }, o.visions.map((v) => h("li", { class: "stack" }, h("strong", { text: v.title }), h("span", { class: "pre", text: v.statement }),
      guarded({ label: "Archive", confirmLabel: "Archive this vision", onConfirm: (_t, box) => run(box, "system.life", "VISION_ARCHIVE", { visionId: v.id }) })))) : empty("No vision yet — write the long-term direction in your own words."),
    h("details", {}, h("summary", { text: "Add a vision" }), formCard({ submit: "Add vision", fields: [{ name: "title", label: "Title", required: true }, { name: "statement", label: "Your words", type: "textarea", required: true }], onSubmit: (b, box) => run(box, "system.life", "VISION_CREATE", b) })));

  // Goals
  const goals = section("Goals",
    o.goals.length ? h("ul", { class: "list" }, o.goals.map((g) => h("li", { class: "stack" },
      h("span", {}, h("strong", { text: g.title }), " ", pill(g.horizon.toLowerCase()), dateBit(g.targetDate, "by"), g.visionId && visionName.get(g.visionId) ? h("span", { class: "muted", text: ` · toward “${visionName.get(g.visionId)}”` }) : null),
      g.description ? h("span", { class: "muted", text: g.description }) : null,
      h("span", { class: "actions" },
        guarded({ label: "Mark achieved", confirmLabel: "Mark achieved", ask: { label: "Note (optional)", required: false }, onConfirm: (t, box) => run(box, "system.life", "GOAL_ACHIEVE", t ? { goalId: g.id, note: t } : { goalId: g.id }) }),
        guarded({ label: "Abandon", confirmLabel: "Abandon goal", ask: { label: "Why? (required)", required: true }, onConfirm: (t, box) => run(box, "system.life", "GOAL_ABANDON", { goalId: g.id, reason: t }) }))))) : empty("No active goals."),
    h("details", {}, h("summary", { text: "Add a goal" }), formCard({ submit: "Add goal", dates: ["targetDate"], fields: [
      { name: "title", label: "Goal", required: true }, { name: "description", label: "Details", type: "textarea" },
      { name: "horizon", label: "Horizon", type: "select", options: HORIZONS, placeholder: "Medium term (default)" }, { name: "targetDate", label: "Target date", type: "date" },
      { name: "visionId", label: "Toward which vision?", type: "select", options: o.visions.map((v) => ({ value: v.id, label: v.title })) }], onSubmit: (b, box) => run(box, "system.life", "GOAL_CREATE", b) })));

  // Projects
  const projects = section("Projects",
    o.projects.length ? h("ul", { class: "list" }, o.projects.map((p) => h("li", { class: "stack" },
      h("span", {}, h("a", { href: `#/life/projects/${p.id}`, class: "strong", text: p.name }), " ", pill(statusLabel(p.status)), p.goalId && goalName.get(p.goalId) ? h("span", { class: "muted", text: ` · for “${goalName.get(p.goalId)}”` }) : null, dateBit(p.targetDate, "by")),
      h("span", { class: "muted", text: taskCountsLine(p.tasks) })))) : empty("No active projects."),
    h("details", {}, h("summary", { text: "Add a project" }), formCard({ submit: "Add project", dates: ["targetDate"], fields: [
      { name: "name", label: "Project", required: true }, { name: "description", label: "Details", type: "textarea" },
      { name: "goalId", label: "For which goal?", type: "select", options: o.goals.map((g) => ({ value: g.id, label: g.title })) }, { name: "targetDate", label: "Target date", type: "date" }], onSubmit: (b, box) => run(box, "system.life", "PROJECT_CREATE", b) })));

  // Open quests (created and worked from a project page)
  const quests = section("Open quests",
    o.quests.length ? h("ul", { class: "list" }, o.quests.map((q) => h("li", { class: "stack" },
      h("span", {}, h("strong", { text: q.title }), " ", pill(statusLabel(q.status)), h("span", { class: "muted" }, " in ", projectName.has(q.projectId) ? h("a", { href: `#/life/projects/${q.projectId}`, text: projectName.get(q.projectId) }) : "a project"), dateBit(q.dueAt, "due")),
      h("span", { class: "muted", text: `Done when: ${q.criteria}` }), questControls(q)))) : empty("No open quests. Add one from a project."));

  // People
  const peopleCard = section("People",
    people.length ? h("ul", { class: "list" }, people.map((p) => personRow(p))) : empty("No people yet."),
    h("details", {}, h("summary", { text: "Add a person" }), formCard({ submit: "Add person", fields: [{ name: "name", label: "Name", required: true }, { name: "relationship", label: "Relationship" }, { name: "notes", label: "Notes", type: "textarea" }], onSubmit: (b, box) => run(box, "system.life", "PERSON_CREATE", b) })));

  mount(view, h("h1", { text: "Life" }), h("div", { class: "grid life" }, h("div", {}, visions, goals, projects, quests), h("div", { class: "side" }, peopleCard, historyCard(history))));
}

function questControls(q) {
  const ts = questTransitions(q.status);
  if (!ts.length) return null;
  return h("span", { class: "actions" }, ts.map((t) => {
    if (!t.ask) return actionButton(t.label, "system.life", t.action, { questId: q.id });
    return guarded({ label: t.label, confirmLabel: t.label, ask: { label: t.ask === "reason" ? "Why? (required)" : "Note (optional)", required: t.ask === "reason" }, onConfirm: (text, box) => run(box, "system.life", t.action, text ? { questId: q.id, [t.ask]: text } : { questId: q.id }) });
  }));
}

/** A one-click, non-terminal action. */
function actionButton(label, skill, name, body) {
  const box = h("span", { class: "result inline" });
  const btn = h("button", { class: "small", text: label, onclick: async () => { btn.disabled = true; const o = await run(box, skill, name, body); if (o.kind !== "success") btn.disabled = false; } });
  return h("span", {}, btn, box);
}

function personRow(p) {
  const view = h("span", { class: "stack" }, h("strong", { text: p.name }), p.relationship ? h("span", { class: "muted", text: p.relationship }) : null, p.notes ? h("span", { class: "pre muted", text: p.notes }) : null);
  const editor = h("details", {}, h("summary", { text: "Edit" }), formCard({ compact: true, submit: "Save", fields: [{ name: "name", label: "Name", required: true, value: p.name }, { name: "relationship", label: "Relationship", value: p.relationship ?? "" }, { name: "notes", label: "Notes", type: "textarea", value: p.notes ?? "" }], onSubmit: (b, box) => run(box, "system.life", "PERSON_UPDATE", { personId: p.id, ...b }) }));
  // Deleting a person is SENSITIVE: the API answers 202 and nothing changes until it is approved.
  const del = guarded({ label: "Delete", confirmLabel: "Ask to delete", onConfirm: (_t, box) => run(box, "system.life", "PERSON_DELETE", { personId: p.id }, { rerender: false }) });
  return h("li", { class: "stack" }, view, editor, del);
}

function historyCard(history) {
  if (!history) return section("History", empty("History isn't available right now."));
  const total = history.goals.length + history.quests.length + history.projects.length + history.visions.length;
  const closed = (t, note) => h("li", { class: "stack muted" }, h("span", {}, t, " ", note));
  return section("History", h("p", { class: "muted", text: "Closed items are final — they can't be reopened or edited." }),
    total === 0 ? empty("Nothing closed yet.") : h("div", {},
      history.goals.length ? h("details", {}, h("summary", { text: `Goals (${history.goals.length})` }), h("ul", { class: "list" }, history.goals.map((g) => closed(g.title, h("span", {}, pill(statusLabel(g.status), g.status === "ACHIEVED" ? "done" : ""), dateBit(g.closedAt, "closed"), g.closedNote ? ` — ${g.closedNote}` : ""))))) : null,
      history.projects.length ? h("details", {}, h("summary", { text: `Projects (${history.projects.length})` }), h("ul", { class: "list" }, history.projects.map((p) => h("li", { class: "stack muted" }, h("a", { href: `#/life/projects/${p.id}`, text: p.name }), " ", pill(statusLabel(p.status)))))) : null,
      history.quests.length ? h("details", {}, h("summary", { text: `Quests (${history.quests.length})` }), h("ul", { class: "list" }, history.quests.map((q) => closed(q.title, h("span", {}, pill(statusLabel(q.status), q.status === "COMPLETED" ? "done" : ""), dateBit(q.closedAt, "closed"), q.closedNote ? ` — ${q.closedNote}` : ""))))) : null,
      history.visions.length ? h("details", {}, h("summary", { text: `Visions (${history.visions.length})` }), h("ul", { class: "list" }, history.visions.map((v) => closed(v.title, pill("archived"))))) : null));
}

// ── Project page ─────────────────────────────────────────────────────────
export async function renderProject(view, id) {
  const token = ++renderToken;
  mount(view, h("p", { class: "muted", text: "Loading…" }));
  const [pr, ppl] = await Promise.all([api("GET", `/api/life/projects/${id}`), api("GET", "/api/life/people")]);
  if (token !== renderToken || !state.active) return;
  const back = h("p", {}, h("a", { href: "#/life", text: "← Life" }));
  if (pr.status !== 200 || pr.body?.status !== "EXECUTED") return mount(view, back, section("Project", outcomeBox(lifeOutcome(pr.status === 200 ? 422 : pr.status, pr.body))));
  const p = pr.body.data;
  const allPeople = okOrList(ppl) ?? [];
  const archived = isTerminal("project", p.status);

  const transitions = projectTransitions(p.status).map((t) => t.to === "ARCHIVED"
    ? guarded({ label: t.label, confirmLabel: "Archive project", onConfirm: (_x, box) => run(box, "system.life", "PROJECT_SET_STATUS", { projectId: p.id, status: t.to }) })
    : actionButton(t.label, "system.life", "PROJECT_SET_STATUS", { projectId: p.id, status: t.to }));
  const head = h("section", { class: "card" }, h("h1", { text: p.name }), h("p", {}, pill(statusLabel(p.status)), dateBit(p.targetDate, "by"), p.completedAt ? dateBit(p.completedAt, "completed") : null),
    p.description ? h("p", { class: "pre", text: p.description }) : null,
    archived ? h("p", { class: "notice", text: "Archived — this project is final and can't be changed." }) : h("div", { class: "actions" }, transitions),
    archived ? null : h("details", {}, h("summary", { text: "Edit name and details" }), formCard({ compact: true, submit: "Save", fields: [{ name: "name", label: "Name", required: true, value: p.name }, { name: "description", label: "Details", type: "textarea", value: p.description ?? "" }], onSubmit: (b, box) => run(box, "system.life", "PROJECT_UPDATE", { projectId: p.id, ...b }) })));

  const questBlock = section("Quests",
    p.quests.length ? h("ul", { class: "list" }, p.quests.map((q) => h("li", { class: "stack" },
      h("span", {}, h("strong", { text: q.title }), " ", pill(statusLabel(q.status)), dateBit(q.dueAt, "due"), q.closedAt ? dateBit(q.closedAt, "closed") : null),
      h("span", { class: "pre", text: q.objective }), h("span", { class: "muted", text: `Done when: ${q.criteria}` }), q.closedNote ? h("span", { class: "muted", text: `Note: ${q.closedNote}` }) : null, questControls(q)))) : empty("No quests yet."),
    archived ? null : h("details", {}, h("summary", { text: "Add a quest" }), formCard({ submit: "Add quest", dates: ["dueAt"], fields: [
      { name: "title", label: "Quest", required: true }, { name: "objective", label: "Objective", type: "textarea", required: true },
      { name: "criteria", label: "Done when…", type: "textarea", required: true, hint: "You define what “done” means. Jarvis never decides a quest is complete." }, { name: "dueAt", label: "Due date", type: "date" }],
      onSubmit: (b, box) => run(box, "system.life", "QUEST_CREATE", { projectId: p.id, ...b }) })));

  const openQuests = p.quests.filter((q) => !isTerminal("quest", q.status));
  const taskBlock = section("Tasks",
    p.tasks.length ? h("ul", { class: "list" }, p.tasks.map((t) => h("li", { class: isTerminal("task", t.status) ? "muted" : "" },
      h("span", { text: t.title }), h("span", { class: "muted", text: ` · ${statusLabel(t.status)}` }), dateBit(t.dueAt, "due"),
      taskTransitions(t.status).map((tr) => actionButton(tr.label, "system.tasks", tr.action, { taskId: t.id })))) ) : empty("No tasks yet."),
    archived ? null : h("details", {}, h("summary", { text: "Add a task" }), formCard({ submit: "Add task", dates: ["dueAt"], fields: [
      { name: "title", label: "Task", required: true }, { name: "dueAt", label: "Due date", type: "date" },
      { name: "questId", label: "For which quest?", type: "select", options: openQuests.map((q) => ({ value: q.id, label: q.title })) }],
      onSubmit: (b, box) => run(box, "system.tasks", "CREATE_TASK", { projectId: p.id, ...b }) })));

  const linkable = linkablePeople(allPeople, p.people);
  const peopleBlock = section("People on this project",
    p.people.length ? h("ul", { class: "list" }, p.people.map((l) => h("li", {}, h("strong", { text: l.person?.name ?? "Someone" }), l.role ? h("span", { class: "muted", text: ` · ${l.role}` }) : null,
      archived ? null : guarded({ label: "Unlink", confirmLabel: "Unlink", onConfirm: (_t, box) => run(box, "system.life", "PROJECT_UNLINK_PERSON", { projectId: p.id, personId: l.personId }) })))) : empty("Nobody linked yet."),
    archived ? null : linkable.length ? h("details", {}, h("summary", { text: "Link a person" }), formCard({ submit: "Link", fields: [
      { name: "personId", label: "Who", type: "select", required: true, options: linkable.map((x) => ({ value: x.id, label: x.name })) }, { name: "role", label: "Role on this project" }],
      onSubmit: (b, box) => run(box, "system.life", "PROJECT_LINK_PERSON", { projectId: p.id, ...b }) })) : h("p", { class: "muted", text: allPeople.length ? "Everyone is already linked." : "Add people on the Life page first." }));

  const knowledgeBlock = p.knowledge.length ? section("Linked knowledge", h("ul", { class: "list" }, p.knowledge.map((k) => h("li", { class: "stack" }, h("strong", { text: k.item?.title ?? "Knowledge item" }), k.note ? h("span", { class: "muted", text: k.note }) : null)))) : null;

  mount(view, back, head, h("div", { class: "grid life" }, h("div", {}, questBlock, taskBlock), h("div", { class: "side" }, peopleBlock, knowledgeBlock)));
}
