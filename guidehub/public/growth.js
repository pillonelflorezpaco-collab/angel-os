import { buildBody, buildStateBody, evidenceGroups, evidenceKindLabel, evidenceText, formatDateOnly, formatWhen, hypothesisLabel, isClosedExperiment, lifeOutcome, metricReadingLine, pickerRow, resultLine, stateHeading, statusLabel, STANCES } from "./lib.js";
import { api, empty, h, mount, outcomeBox, section } from "./ui.js";
import { state } from "./ui.js";
import { formCard, guarded, nextId, pill, run } from "./kit.js";

// Step 5: Future Self and Learning. A VIEW over what the server already holds: no rule about states, evidence or hypotheses lives here —
// when the server refuses something, its own words are shown. Every mutation is an ordinary action through the cockpit's proxy (so approvals,
// audit and interface policy apply as everywhere else). Labels on evidence are always the server's; this UI only ever sends ids.

const FUTURE = "system.future";
const LEARNING = "system.learning";
let futureToken = 0;
let learningToken = 0;
const data = (r) => (r.status === 200 && r.body?.status === "EXECUTED" ? r.body.data : null);
const failure = (r) => outcomeBox(lifeOutcome(r.status === 200 ? 403 : r.status, r.body));
const labelled = (id, label, control, hint) => h("div", { class: "field" }, h("label", { for: id, text: label }), control, hint ? h("p", { class: "muted hint", text: hint }) : null);

// ── Evidence display (shared) ─────────────────────────────────────────────
function evidenceList(links, { context = "" } = {}) {
  if (!links?.length) return h("p", { class: "muted", text: "No evidence is recorded." }); // silence is not a finding
  return h("div", { class: "stack" }, evidenceGroups(links).filter((g) => g.items.length).map((g) =>
    h("div", { class: "stack" }, h("h4", { text: g.label }), h("ul", { class: "list" }, g.items.map((l) =>
      h("li", { class: "stack" }, h("span", {}, pill(evidenceKindLabel(l)), " ", h("span", { text: evidenceText(l) })),
        h("span", { class: "muted", text: `Linked ${formatDateOnly(l.createdAt)}${l.note ? ` · ${l.note}` : ""}${context}` })))))));
}

// ── Evidence picker: finds YOUR results and memories by asking the server; a pick carries an id, not a label ──
function evidencePicker(chosen, redraw) {
  const stanceId = nextId("st");
  const stance = h("select", { id: stanceId }, STANCES.map((s) => h("option", { value: s.value, text: s.label })));
  const msg = h("p", { class: "muted", role: "status" });
  const out = h("ul", { class: "list picks" });
  const use = (sourceKind, sourceId, shown, sub) => {
    if (chosen.some((c) => c.sourceKind === sourceKind && c.sourceId === sourceId)) { msg.textContent = "That is already added."; return; }
    if (chosen.length >= 10) { msg.textContent = "At most 10 pieces of evidence."; return; }
    msg.textContent = "";
    chosen.push({ sourceKind, sourceId, stance: stance.value, shown, sub });
    redraw();
  };
  const row = (sourceKind, sourceId, title, sub) => h("li", { class: "stack" }, h("span", { text: title }), h("span", { class: "muted", text: sub }),
    h("button", { type: "button", class: "small", text: "Use as evidence", "aria-label": `Use as evidence: ${title}`, onclick: () => use(sourceKind, sourceId, title, sub) }));
  const qid = nextId("q");
  const q = h("input", { id: qid, type: "text", maxlength: "200", placeholder: "Search your memories…" });
  const searchMem = h("button", { type: "button", class: "small", text: "Search memories", onclick: async () => {
    mount(out, h("li", { class: "muted", text: "Searching…" }));
    const r = await api("GET", `/api/memory/search?q=${encodeURIComponent(q.value.trim())}`);
    const list = data(r);
    if (!Array.isArray(list)) return mount(out, h("li", { class: "muted", text: "Couldn't search right now." }));
    mount(out, list.length ? list.slice(0, 8).map((m) => { const p = pickerRow("MEMORY", m); return row("MEMORY", p.refId, p.title, `${m.type ? String(m.type).toLowerCase() : "memory"} · ${p.sub}${m.type === "EXPERIENCE" || m.type === "LESSON" ? "" : " · not lived evidence — the server will refuse it"}`); }) : h("li", { class: "muted", text: "Nothing found." }));
  } });
  const listResults = h("button", { type: "button", class: "small", text: "Show my results", onclick: async () => {
    mount(out, h("li", { class: "muted", text: "Loading…" }));
    const list = data(await api("GET", "/api/results"));
    if (!Array.isArray(list)) return mount(out, h("li", { class: "muted", text: "Couldn't load results right now." }));
    mount(out, list.length ? list.slice(0, 8).map((r) => row("RESULT", r.id, resultLine(r), `recorded ${formatDateOnly(r.recordedAt)}`)) : h("li", { class: "muted", text: "No results are recorded." }));
  } });
  return h("div", { class: "stack" }, labelled(stanceId, "How does this evidence relate?", stance), labelled(qid, "Find", q), h("span", { class: "actions" }, searchMem, listResults), msg, out);
}

function chosenChips(chosen, redraw) {
  const box = h("ul", { class: "chips" });
  const draw = () => mount(box, chosen.map((c, i) => h("li", {}, pill(c.stance.toLowerCase()), " ", h("span", { text: c.shown }), " ",
    h("button", { type: "button", class: "link", text: "Remove", "aria-label": `Remove evidence: ${c.shown}`, onclick: () => { chosen.splice(i, 1); draw(); redraw?.(); } }))));
  draw();
  return { box, draw };
}

// ── Future Self ───────────────────────────────────────────────────────────
function stateForm(a, onDone) {
  const chosen = [];
  const chips = chosenChips(chosen);
  const status = h("div", { class: "result" });
  const errors = h("div", { role: "alert" });
  const el = {};
  const field = (name, label, value, { area = true, required = false } = {}) => {
    const id = nextId("sf");
    el[name] = area ? h("textarea", { id, rows: "2", maxlength: "2000", required }) : h("input", { id, type: "text", maxlength: "1000" });
    el[name].value = value ?? "";
    return labelled(id, label + (required ? "" : " (optional)"), el[name]);
  };
  const btn = h("button", { type: "submit", class: "primary", text: "Record updated state" });
  const form = h("form", { class: "stack form" },
    h("p", { class: "muted", text: "This adds a new dated record. The earlier states stay exactly as they were, and this one keeps the evidence it was recorded with." }),
    field("current", "Current state, in your words", a.current, { required: true }), field("gap", "Gap", a.gap), field("desired", "Desired state", a.desired, { required: true }), field("note", "Note", ""),
    h("fieldset", {}, h("legend", { text: "Evidence for this change" }), chips.box, evidencePicker(chosen, chips.draw)),
    errors, btn, status);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { body, errors: errs } = buildStateBody(a.id, Object.fromEntries(Object.entries(el).map(([k, n]) => [k, n.value])), chosen);
    if (errs.length) return mount(errors, h("ul", { class: "errors" }, errs.map((t) => h("li", { text: t }))));
    mount(errors);
    btn.disabled = true;
    const o = await run(status, FUTURE, "ASPIRATION_STATE_RECORD", body, { rerender: false });
    btn.disabled = false;
    if (o.kind === "success") onDone();
  });
  return form;
}

function stateTimelineView(states) {
  if (!states) return h("p", { class: "muted", text: "State history couldn't be loaded." });
  return h("ol", { class: "timeline" }, states.map((s, i) => h("li", { class: i === states.length - 1 ? "stack" : "stack historical" },
    h("strong", { text: stateHeading(s, i, states.length) }),
    h("span", { text: `Current state recorded: ${s.current}` }),
    s.gap ? h("span", { text: `Gap: ${s.gap}` }) : null,
    h("span", { text: `Desired state: ${s.desired}` }),
    s.note ? h("span", { class: "muted", text: `Note: ${s.note}` }) : null,
    s.basis === "INITIAL" ? h("span", { class: "muted", text: "Starting statement — no evidence was required." }) : evidenceList(s.evidence))));
}

async function aspirationCard(a, refresh) {
  const r = await api("GET", `/api/future/aspirations/${a.id}/states`);
  const states = data(r);
  const latest = Array.isArray(states) ? states.at(-1) : null;
  const formBox = h("div");
  const toggle = h("button", { class: "small", text: "Record an updated state", onclick: () => mount(formBox, stateForm(a, refresh)) });
  const next = a.nextTask ? `Task: ${a.nextTask.title} (${statusLabel(a.nextTask.status)})` : a.nextQuest ? `Quest: ${a.nextQuest.title} (${statusLabel(a.nextQuest.status)})` : null;
  return h("article", { class: "card aspiration", "data-aspiration": a.id },
    h("h3", { text: a.title }), a.area ? pill(a.area) : null,
    h("dl", { class: "facts" },
      h("dt", { text: "Current state recorded" }), h("dd", { text: a.current }),
      h("dt", { text: "Desired state" }), h("dd", { text: a.desired }),
      h("dt", { text: "Gap" }), h("dd", { text: a.gap ?? "No gap recorded." }),
      h("dt", { text: "Next action" }), h("dd", { text: next ?? "No next action linked." })),
    a.metrics?.length ? h("div", { class: "stack" }, h("h4", { text: "Measures you defined" }), h("ul", { class: "list" }, a.metrics.map((m) =>
      h("li", { class: "stack" }, h("strong", { text: m.name }), h("span", { class: "muted", text: m.definition || "No definition recorded." }),
        h("span", { class: "muted", text: `Baseline ${m.baseline} → target ${m.target} ${m.unit}` }), h("span", { text: metricReadingLine(m) }))))) : null,
    h("h4", { text: "Evidence behind the latest state" }), latest && latest.basis !== "INITIAL" ? evidenceList(latest.evidence) : h("p", { class: "muted", text: latest ? "The starting state has no evidence attached." : "Evidence couldn't be loaded." }),
    h("h4", { text: "State history" }), stateTimelineView(states),
    toggle, formBox);
}

export async function renderFuture(view) {
  const token = ++futureToken;
  mount(view, h("p", { class: "muted", text: "Loading…" }));
  const r = await api("GET", "/api/future/aspirations");
  if (token !== futureToken || !state.active) return;
  const list = data(r);
  const refresh = () => renderFuture(view);
  const create = section("Add an aspiration", formCard({
    fields: [{ name: "title", label: "Title", required: true, maxlength: 200 }, { name: "current", label: "Where are you now, in your words?", type: "textarea", required: true }, { name: "gap", label: "Gap", type: "textarea" }, { name: "desired", label: "Where do you want to be?", type: "textarea", required: true }],
    submit: "Add aspiration", onSubmit: (body, status) => run(status, FUTURE, "ASPIRATION_CREATE", body),
  }));
  if (!Array.isArray(list)) return mount(view, h("h1", { text: "Future Self" }), section("Aspirations", failure(r)));
  const cards = await Promise.all(list.map((a) => aspirationCard(a, refresh)));
  if (token !== futureToken || !state.active) return;
  mount(view, h("h1", { text: "Future Self" }),
    h("p", { class: "muted", text: "Current state → desired state → gap → evidence → next action. What's shown is what you recorded and what the evidence says — not a verdict." }),
    cards.length ? cards : section("Aspirations", empty("No aspirations are recorded yet.")), create);
  state.refresh = refresh;
}

// ── Learning ──────────────────────────────────────────────────────────────
function experimentDetail(id, refresh) {
  const box = h("div", { class: "stack" }, h("p", { class: "muted", text: "Loading…" }));
  (async () => {
    const r = await api("GET", `/api/learning/experiments/${id}`);
    const e = data(r);
    if (!e) return mount(box, failure(r));
    const closed = isClosedExperiment(e.status);
    const obsForm = formCard({ compact: true, submit: "Record observation", fields: [{ name: "text", label: "What did you observe?", type: "textarea", required: true }, { name: "observedAt", label: "When", type: "date" }], dates: ["observedAt"],
      onSubmit: (body, status) => run(status, LEARNING, "EXPERIMENT_OBSERVE", { experimentId: id, ...body }, { rerender: false }).then((o) => { if (o.kind === "success") refresh(); return o; }) });
    const moveId = nextId("mv");
    const moveTo = h("select", { id: moveId }, ["OBSERVED", "SUPPORTED", "CONFIRMED", "REJECTED"].map((s) => h("option", { value: s, text: s.toLowerCase() })));
    const moveNote = h("input", { id: nextId("mn"), type: "text", maxlength: "2000", placeholder: "Review note (optional)" });
    const moveStatus = h("div", { class: "result" });
    const moveBtn = h("button", { class: "small primary", text: "Record review", onclick: async () => {
      const body = { experimentId: id, to: moveTo.value }; if (moveNote.value.trim()) body.note = moveNote.value.trim();
      moveBtn.disabled = true;
      const o = await run(moveStatus, LEARNING, "EXPERIMENT_TRANSITION", body, { rerender: false });
      moveBtn.disabled = false;
      if (o.kind === "success") refresh();
    } });
    const attach = (() => {
      const chosen = [];
      const chips = chosenChips(chosen);
      const status = h("div", { class: "result" });
      const go = h("button", { class: "small primary", text: "Link evidence", onclick: async () => {
        if (!chosen.length) return mount(status, outcomeBox({ tone: "bad", kind: "invalid", text: "Pick some evidence first." }));
        go.disabled = true;
        let ok = true;
        for (const c of chosen) { const o = await run(status, FUTURE, "EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: id, sourceKind: c.sourceKind, sourceId: c.sourceId, stance: c.stance }, { rerender: false }); if (o.kind !== "success") { ok = false; break; } }
        go.disabled = false;
        if (ok) refresh();
      } });
      const obsPick = e.observations.map((o) => h("li", { class: "stack" }, h("span", { text: o.text }), h("button", { type: "button", class: "small", text: "Use this observation as evidence", onclick: () => { if (!chosen.some((c) => c.sourceId === o.id)) { chosen.push({ sourceKind: "OBSERVATION", sourceId: o.id, stance: "SUPPORTS", shown: o.text }); chips.draw(); } } })));
      return h("div", { class: "stack" }, h("h4", { text: "Link evidence" }), obsPick.length ? h("ul", { class: "list picks" }, obsPick) : null, evidencePicker(chosen, chips.draw), chips.box, go, status);
    })();
    const lessonForm = formCard({ compact: true, submit: "Record lesson", fields: [{ name: "content", label: "What did you learn from this experiment?", type: "textarea", required: true, hint: "A lesson is a separate record that points back here; it doesn't change the experiment." }],
      onSubmit: (body, status) => run(status, LEARNING, "LESSON_RECORD", { experimentId: id, ...body }, { rerender: false }).then((o) => { if (o.kind === "success") refresh(); return o; }) });
    mount(box,
      h("p", { text: `Method: ${e.method}` }),
      h("h4", { text: "Observations" }), e.observations.length ? h("ul", { class: "list" }, e.observations.map((o) => h("li", { class: "stack" }, h("span", { text: o.text }), h("span", { class: "muted", text: `Observed ${formatDateOnly(o.observedAt)}` })))) : h("p", { class: "muted", text: "No observations are recorded." }),
      h("h4", { text: "Evidence and results" }), evidenceList(e.evidence),
      h("h4", { text: "Review history" }), h("ol", { class: "timeline" }, e.changes.map((c) => h("li", { class: "stack historical" }, h("span", { text: c.fromStatus === c.toStatus ? `Proposed on ${formatDateOnly(c.createdAt)}` : `${hypothesisLabel(c.fromStatus)} → ${hypothesisLabel(c.toStatus)} on ${formatDateOnly(c.createdAt)}` }), c.note ? h("span", { class: "muted", text: `Note: ${c.note}` }) : null))),
      h("h4", { text: "Lessons" }), e.lessons.length ? h("ul", { class: "list" }, e.lessons.map((l) => h("li", { class: "stack" }, pill("Lesson"), " ", h("span", { text: l.content }), h("span", { class: "muted", text: `Recorded ${formatDateOnly(l.createdAt)}` })))) : h("p", { class: "muted", text: "No lessons are recorded." }),
      closed ? h("p", { class: "notice", text: "This experiment's record is closed. You can still record a lesson from it." }) : h("div", { class: "stack" }, h("h4", { text: "Add to this experiment" }), obsForm, attach,
        h("h4", { text: "Review" }), h("p", { class: "muted", text: "Moving an experiment forward is a review. Angel OS checks the observations and evidence and tells you if something is missing." }), labelled(moveId, "Move to", moveTo), moveNote, moveBtn, moveStatus),
      e.observations.length ? lessonForm : null);
  })();
  return box;
}

export async function renderLearning(view) {
  const token = ++learningToken;
  mount(view, h("p", { class: "muted", text: "Loading…" }));
  const [objR, expR, sesR, topR] = await Promise.all([api("GET", "/api/learning/objectives"), api("GET", "/api/learning/experiments"), api("GET", "/api/learning/sessions"), api("GET", "/api/learning/topics")]);
  if (token !== learningToken || !state.active) return;
  const refresh = () => renderLearning(view);
  const objectives = data(objR), experiments = data(expR), sessions = data(sesR), topics = data(topR);

  const objectiveSection = section("Objectives", !Array.isArray(objectives) ? failure(objR) : h("div", { class: "stack" },
    objectives.length ? h("ul", { class: "list" }, objectives.map((o) => h("li", { class: "stack", "data-objective": o.id }, h("strong", { text: o.title }), " ", pill(statusLabel(o.status)),
      h("span", { text: `Your evidence standard: ${o.evidenceStandard}` }),
      h("span", { class: "muted", text: o.evidence.total ? `${o.evidence.supports} supporting, ${o.evidence.contradicts} contradicting, ${o.evidence.context} context` : "No evidence is recorded." }),
      o.status === "ACTIVE" ? h("span", { class: "actions" },
        guarded({ label: "Mark met", confirmLabel: "Mark met", onConfirm: (_t, box) => run(box, LEARNING, "OBJECTIVE_CLOSE", { objectiveId: o.id, outcome: "MET" }) }),
        guarded({ label: "Abandon", confirmLabel: "Abandon", ask: { label: "Why?", required: true }, onConfirm: (t, box) => run(box, LEARNING, "OBJECTIVE_CLOSE", { objectiveId: o.id, outcome: "ABANDONED", note: t }) })) : null))) : empty("No objectives are recorded."),
    formCard({ compact: true, submit: "Add objective", fields: [{ name: "title", label: "Objective", required: true }, { name: "evidenceStandard", label: "What would count as evidence, by your standard?", type: "textarea", required: true }],
      onSubmit: (body, status) => run(status, LEARNING, "OBJECTIVE_CREATE", body) })));

  const expSection = section("Experiments", !Array.isArray(experiments) ? failure(expR) : h("div", { class: "stack" },
    h("p", { class: "muted", text: "Hypothesis → observation → result → review → lesson. A status describes this experiment for you; it is not a general claim." }),
    experiments.length ? experiments.map((e) => {
      const det = h("details", { "data-experiment": e.id }, h("summary", {}, h("strong", { text: e.hypothesis }), " ", pill(e.status.toLowerCase())));
      let loaded = false;
      det.addEventListener("toggle", () => { if (det.open && !loaded) { loaded = true; det.append(experimentDetail(e.id, refresh)); } });
      return h("div", { class: "stack" }, det, h("span", { class: "muted", text: hypothesisLabel(e.status) }));
    }) : empty("No experiments are recorded."),
    formCard({ compact: true, submit: "Propose experiment", fields: [{ name: "hypothesis", label: "Hypothesis", type: "textarea", required: true }, { name: "method", label: "Method — what will you do?", type: "textarea", required: true }],
      onSubmit: (body, status) => run(status, LEARNING, "EXPERIMENT_CREATE", body) })));

  const sessionSection = section("Study sessions", !Array.isArray(sessions) ? failure(sesR) : sessions.length ? h("ul", { class: "list" }, sessions.slice(0, 20).map((s) => h("li", { class: "stack" }, h("span", { text: `${s.minutes} minutes on ${s.topicTitle}` }), h("span", { class: "muted", text: `Self-reported · ${formatWhen(s.studiedAt, state.timeZone)}${s.note ? ` · ${s.note}` : ""}` })))) : empty("No study sessions are recorded."));

  const topicSection = Array.isArray(topics) && topics.length ? section("Topics", h("ul", { class: "list" }, topics.map((t) => h("li", { class: "stack" }, h("strong", { text: t.title }), " ", pill(statusLabel(t.status)), h("span", { class: "muted", text: `${t.minutesLast30Days} minutes in the last 30 days (self-reported)` }))))) : null;

  mount(view, h("h1", { text: "Learning" }), objectiveSection, expSection, sessionSection, topicSection);
  state.refresh = refresh;
}
