import { EVIDENCE_KINDS, LIMITS, buildDecisionBody, buildResultBody, canReview, canSupersede, decisionStatus, evidenceTag, formatDateOnly, formatWhen, lifeOutcome, pickerRow, resultLine, withSuperseded } from "./lib.js";
import { api, empty, h, mount, outcomeBox, section, state } from "./ui.js";
import { nextId, pill, run } from "./kit.js";

// Step 3: Decisions (docs/guidehub/cockpit-design.md §3). A decision is HISTORY: recorded once, never edited — there is no edit control anywhere here.
// Changing your mind records a NEW decision that replaces the old one (which stays exactly as written). The look-back fills in what actually happened,
// once, next to what was expected; nothing here grades it. Evidence labels are the server's snapshots — this UI never sends a label.

let renderToken = 0;
const resultData = (r) => (r.status === 200 && r.body?.status === "EXECUTED" ? r.body.data : null);
const excerpt = (t, n = 160) => (t.length > n ? `${t.slice(0, n)}…` : t);
const labelled = (id, label, control, hint) => h("div", { class: "field" }, h("label", { for: id, text: label }), control, hint ? h("p", { class: "muted hint", text: hint }) : null);

async function searchEvidence(kind, q) {
  const path = kind === "MEMORY" ? `/api/memory/search?q=${encodeURIComponent(q)}` : kind === "KNOWLEDGE" ? `/api/knowledge/search?q=${encodeURIComponent(q)}` : "/api/tasks";
  const list = resultData(await api("GET", path));
  if (!Array.isArray(list)) return null;
  const hits = kind === "TASK" && q ? list.filter((t) => t.title.toLowerCase().includes(q.toLowerCase())) : list;
  return hits.slice(0, 8).map((hit) => pickerRow(kind, hit));
}

// ── The record form (also used to replace an existing decision) ───────────
function recordForm({ supersedes = null } = {}) {
  const status = h("div", { class: "result" });
  const el = {};
  const text = (name, label, { required = false, area = false, type = "text", hint, max = 2000 } = {}) => {
    const id = nextId("d");
    el[name] = area ? h("textarea", { id, rows: "2", maxlength: String(max), required }) : h("input", { id, type, maxlength: String(max), required });
    return labelled(id, label + (required ? "" : " (optional)"), el[name], hint);
  };
  const basics = [
    text("title", "Title", { required: true, max: 300 }),
    text("question", "What are you deciding?", { area: true }),
    text("decision", "What did you decide?", { required: true, area: true }),
    text("reasoning", "Why?", { area: true }),
    text("expected", "What do you expect to happen?", { area: true, hint: "Write it down now — you'll compare it with what actually happens, without anyone grading it." }),
    text("reviewAt", "Look back on", { type: "date", hint: "When should this come back to you?" }),
  ];

  // options (2–6, one chosen) — optional
  const rows = [];
  const optionBox = h("div", { class: "options" });
  const radio = nextId("chosen");
  const addOption = h("button", { type: "button", class: "small", text: "Add an option" });
  const refreshAdd = () => { addOption.disabled = rows.length >= LIMITS.options.max; };
  addOption.addEventListener("click", () => {
    const id = nextId("o");
    const r = { label: h("input", { id: `${id}-l`, type: "text", maxlength: "300" }), pros: h("input", { id: `${id}-p`, type: "text", maxlength: "2000" }), cons: h("input", { id: `${id}-c`, type: "text", maxlength: "2000" }), chosen: h("input", { id: `${id}-x`, type: "radio", name: radio }) };
    r.row = h("div", { class: "option" }, labelled(`${id}-l`, "Option", r.label), labelled(`${id}-p`, "For it (optional)", r.pros), labelled(`${id}-c`, "Against it (optional)", r.cons),
      h("div", { class: "actions" }, r.chosen, h("label", { for: `${id}-x`, text: "This is the one I chose" }),
        h("button", { type: "button", class: "link", text: "Remove option", onclick: () => { rows.splice(rows.indexOf(r), 1); r.row.remove(); refreshAdd(); } })));
    rows.push(r);
    optionBox.append(r.row);
    refreshAdd();
    r.label.focus();
  });

  // evidence: notes, or references to your own memories / knowledge / tasks (the server writes the label from YOUR row)
  const evidence = [];
  const chips = h("ul", { class: "chips" });
  const drawChips = () => mount(chips, evidence.map((e, i) => h("li", {}, pill(evidenceTag(e.kind)), " ", h("span", { text: e.shown }), " ",
    h("button", { type: "button", class: "link", text: "Remove", "aria-label": `Remove evidence: ${e.shown}`, onclick: () => { evidence.splice(i, 1); drawChips(); } }))));
  const evMsg = h("p", { class: "muted", role: "status" });
  const push = (e) => { if (evidence.length >= LIMITS.evidence) { evMsg.textContent = `At most ${LIMITS.evidence} pieces of evidence.`; return; } evMsg.textContent = ""; evidence.push(e); drawChips(); };
  const noteId = nextId("n");
  const noteInput = h("input", { id: noteId, type: "text", maxlength: "500" });
  const addNote = h("button", { type: "button", class: "small", text: "Add note", onclick: () => { const t = noteInput.value.trim(); if (!t) return; push({ kind: "NOTE", note: t, shown: t }); noteInput.value = ""; } });
  const picker = (kind, label) => {
    const id = nextId("s");
    const q = h("input", { id, type: "text", maxlength: "200", placeholder: kind === "TASK" ? "Part of the title (or empty for all)" : "Search…" });
    const out = h("ul", { class: "list picks" });
    const go = h("button", { type: "button", class: "small", text: "Search", onclick: async () => {
      mount(out, h("li", { class: "muted", text: "Searching…" }));
      const found = await searchEvidence(kind, q.value.trim());
      if (!found) return mount(out, h("li", { class: "muted", text: "Couldn't search right now." }));
      mount(out, found.length ? found.map((row) => h("li", { class: "stack" }, h("span", { text: row.title }), h("span", { class: "muted", text: row.sub }),
        h("button", { type: "button", class: "small", text: "Use as evidence", "aria-label": `Use as evidence: ${row.title}`, onclick: () => push({ kind, refId: row.refId, shown: row.title }) }))) : h("li", { class: "muted", text: "Nothing found." }));
    } });
    return h("details", {}, h("summary", { text: `Add from ${label}` }), labelled(id, "Find", q), go, out);
  };

  const errors = h("div", { role: "alert" });
  const btn = h("button", { type: "submit", class: "primary", text: supersedes ? "Record the new decision" : "Record decision" });
  const form = h("form", { class: "stack form" },
    supersedes ? h("p", { class: "notice", text: `This records a NEW decision that replaces “${supersedes.title}”. The old one stays exactly as written.` }) : null,
    ...basics,
    h("fieldset", {}, h("legend", { text: "Options you compared (optional)" }), h("p", { class: "muted hint", text: `List ${LIMITS.options.min}–${LIMITS.options.max}, or none.` }), optionBox, addOption),
    h("fieldset", {}, h("legend", { text: "Evidence (optional)" }), h("p", { class: "muted hint", text: "A reference points at your own memory, knowledge or task — it is not proof, and it doesn't turn a guess into a fact." }),
      chips, evMsg, labelled(noteId, "A note", noteInput), addNote, picker("MEMORY", "a memory"), picker("KNOWLEDGE", "knowledge"), picker("TASK", "a task")),
    errors, btn, status);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(Object.entries(el).map(([k, node]) => [k, node.value]));
    const chosen = rows.findIndex((r) => r.chosen.checked);
    const { body, errors: errs } = buildDecisionBody(values, rows.map((r) => ({ label: r.label.value, pros: r.pros.value, cons: r.cons.value })), chosen === -1 ? null : chosen,
      evidence.map(({ kind, refId, note }) => ({ kind, refId, note })), supersedes?.id ?? null);
    if (errs.length) return mount(errors, h("ul", { class: "errors" }, errs.map((t) => h("li", { text: t }))));
    mount(errors);
    btn.disabled = true;
    const o = await run(status, "system.decisions", "DECISION_RECORD", body, { rerender: false });
    if (o.kind === "success" && o.data?.id) { location.hash = `#/decisions/${o.data.id}`; return; }
    btn.disabled = false;
  });
  return form;
}

// ── List ─────────────────────────────────────────────────────────────────
export async function renderDecisions(view) {
  const token = ++renderToken;
  mount(view, h("p", { class: "muted", text: "Loading…" }));
  const r = await api("GET", "/api/decisions");
  if (token !== renderToken || !state.active) return;
  const list = resultData(r);
  if (!Array.isArray(list)) return mount(view, h("h1", { text: "Decisions" }), section("Decisions", outcomeBox(lifeOutcome(r.status === 200 ? 403 : r.status, r.body))));
  const now = Date.now();
  const rows = withSuperseded(list);
  const kind = (d) => decisionStatus(d, now).kind;
  const row = (d) => h("li", { class: "stack" }, h("span", {}, h("a", { href: `#/decisions/${d.id}`, class: "strong", text: d.title }), " ", pill(decisionStatus(d, now).label), h("span", { class: "muted", text: ` · decided ${formatDateOnly(d.decidedAt)}` })), h("span", { class: "muted", text: excerpt(d.decision) }));
  const group = (title, items, emptyText) => section(title, items.length ? h("ul", { class: "list" }, items.map(row)) : empty(emptyText));
  const form = h("details", { open: rows.length === 0 }, h("summary", { text: "Record a decision" }), recordForm());
  mount(view, h("h1", { text: "Decisions" }),
    h("p", { class: "muted", text: "A decision is history: recorded once, never edited. To change your mind, record a new one that replaces it." }),
    h("div", { class: "card" }, form),
    group("Time to look back", rows.filter((d) => kind(d) === "due"), "Nothing is waiting for a look-back."),
    rows.some((d) => kind(d) === "waiting") ? group("Waiting for their date", rows.filter((d) => kind(d) === "waiting"), "") : null,
    group("Other decisions", rows.filter((d) => kind(d) !== "due" && kind(d) !== "waiting"), rows.some((d) => kind(d) === "due" || kind(d) === "waiting") ? "Nothing else yet." : "No decisions yet."));
}

// ── Detail ───────────────────────────────────────────────────────────────
export async function renderDecision(view, id) {
  const token = ++renderToken;
  mount(view, h("p", { class: "muted", text: "Loading…" }));
  const [dr, rr] = await Promise.all([api("GET", `/api/decisions/${id}`), api("GET", `/api/results?subjectKind=DECISION&subjectId=${id}`)]);
  if (token !== renderToken || !state.active) return;
  const back = h("p", {}, h("a", { href: "#/decisions", text: "← Decisions" }));
  const d = resultData(dr);
  if (!d) return mount(view, back, section("Decision", outcomeBox(lifeOutcome(dr.status === 200 ? 422 : dr.status, dr.body))));
  const results = resultData(rr);
  const st = decisionStatus(d, Date.now());

  const options = d.options?.length ? h("div", {}, h("h3", { text: "Options" }), h("ul", { class: "list" }, d.options.map((o) => h("li", { class: "stack" },
    h("span", {}, h("strong", { text: o.label }), " ", o.chosen ? pill("chosen", "done") : null),
    o.pros ? h("span", { class: "muted", text: `For: ${o.pros}` }) : null, o.cons ? h("span", { class: "muted", text: `Against: ${o.cons}` }) : null)))) : null;
  const head = h("section", { class: "card" }, h("h1", { text: d.title }),
    h("p", {}, pill(st.label), h("span", { class: "muted", text: ` · decided ${formatWhen(d.decidedAt, state.timeZone)}` })),
    h("p", { class: "notice", text: "Decisions are history — this one can't be edited. Changed your mind? Record a new decision that replaces it." }),
    d.question ? h("div", {}, h("h3", { text: "The question" }), h("p", { class: "pre", text: d.question })) : null, options,
    h("h3", { text: "The decision" }), h("p", { class: "pre", text: d.decision }),
    d.reasoning ? h("div", {}, h("h3", { text: "Why" }), h("p", { class: "pre", text: d.reasoning })) : null,
    d.context ? h("div", {}, h("h3", { text: "Context" }), h("p", { class: "pre", text: d.context })) : null);

  const evidence = section("Evidence", d.evidence?.length ? h("ul", { class: "list" }, d.evidence.map((e) => h("li", {}, pill(evidenceTag(e.kind)), " ", h("span", { text: e.label })))) : empty("No evidence attached."),
    h("p", { class: "muted hint", text: "A reference points at something you had at the time; it is a pointer, not proof, and the label is a snapshot." }));

  // expected vs actual, side by side — never graded
  let lookBack;
  if (d.reviewedAt) {
    lookBack = section("What you expected, and what happened", h("div", { class: "compare" },
      h("div", {}, h("h3", { text: "You expected" }), h("p", { class: "pre", text: d.expected || "You didn't write an expectation." })),
      h("div", {}, h("h3", { text: "What happened" }), h("p", { class: "pre", text: d.outcome ?? "" }))),
      d.lesson ? h("div", {}, h("h3", { text: "What you learned" }), h("p", { class: "pre", text: d.lesson })) : null,
      h("p", { class: "muted hint", text: `Looked back on ${formatWhen(d.reviewedAt, state.timeZone)}. This is final.` }));
  } else if (canReview(d)) {
    const status = h("div", { class: "result" });
    const oId = nextId("r"), lId = nextId("r");
    const outcome = h("textarea", { id: oId, rows: "3", required: true, maxlength: "2000" });
    const lesson = h("textarea", { id: lId, rows: "2", maxlength: "2000" });
    const btn = h("button", { type: "submit", class: "primary", text: "Record the look-back" });
    const form = h("form", { class: "stack form" }, labelled(oId, "What actually happened?", outcome), labelled(lId, "What did you learn? (optional)", lesson), h("p", { class: "muted hint", text: "You can only do this once — it can't be edited afterwards." }), btn, status);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const o = outcome.value.trim();
      if (!o) return mount(status, outcomeBox({ tone: "bad", kind: "invalid", text: "Say what happened." }));
      btn.disabled = true;
      const res = await run(status, "system.decisions", "DECISION_REVIEW", lesson.value.trim() ? { decisionId: d.id, outcome: o, lesson: lesson.value.trim() } : { decisionId: d.id, outcome: o });
      if (res.kind !== "success") btn.disabled = false;
    });
    lookBack = section("What you expected", h("p", { class: "pre", text: d.expected || "You didn't write an expectation." }), h("h3", { text: "Look back" }), form);
  }

  const chain = (d.supersedes || d.supersededBy) ? section("This decision's history",
    d.supersedes ? h("p", {}, "Replaces: ", h("a", { href: `#/decisions/${d.supersedes.id}`, text: d.supersedes.title })) : null,
    d.supersededBy ? h("p", {}, "Replaced by: ", h("a", { href: `#/decisions/${d.supersededBy.id}`, text: d.supersededBy.title })) : null) : null;
  const change = canSupersede(d) ? section("Change my mind", h("details", {}, h("summary", { text: "Record a new decision that replaces this one" }), recordForm({ supersedes: d }))) : null;

  // results: append-only notes about what happened
  const rStatus = h("div", { class: "result" });
  const sId = nextId("x"), vId = nextId("x"), uId = nextId("x");
  const statement = h("textarea", { id: sId, rows: "2", required: true, maxlength: "2000" });
  const value = h("input", { id: vId, type: "text", inputmode: "decimal", maxlength: "40" });
  const unit = h("input", { id: uId, type: "text", maxlength: "40" });
  const rBtn = h("button", { type: "submit", class: "small primary", text: "Record result" });
  const rForm = h("form", { class: "stack form" }, labelled(sId, "What happened?", statement), labelled(vId, "Measurement (optional)", value, "A number, with its unit below."), labelled(uId, "Unit (optional)", unit), rBtn, rStatus);
  rForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { body, errors } = buildResultBody({ statement: statement.value, value: value.value, unit: unit.value }, d.id);
    if (errors.length) return mount(rStatus, h("ul", { class: "errors", role: "alert" }, errors.map((t) => h("li", { text: t }))));
    rBtn.disabled = true;
    const o = await run(rStatus, "system.life", "RESULT_RECORD", body);
    if (o.kind !== "success") rBtn.disabled = false;
  });
  const resultsCard = section("Results",
    results === null ? empty("Results aren't available right now.") : results.length ? h("ul", { class: "list" }, results.map((x) => h("li", { class: "stack" }, h("span", { text: resultLine(x) }), h("span", { class: "muted", text: formatWhen(x.recordedAt, state.timeZone) })))) : empty("No results recorded yet."),
    h("p", { class: "muted hint", text: "Results are notes about what happened. They are added, never edited." }), h("details", {}, h("summary", { text: "Record a result" }), rForm));

  mount(view, back, head, h("div", { class: "grid life" }, h("div", {}, lookBack, evidence, resultsCard), h("div", { class: "side" }, chain, change)));
}
