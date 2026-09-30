import { GRADES, approvalOutcome, countdown, formatWhen, learningLine, listFrom, memoryLine, parseRoute, progressLabel, riskLabel, sectionNotices, writeOutcome } from "./lib.js";
import { api, empty, h, mount, onAuthLost, outcomeBox, section, state } from "./ui.js";
import { renderLife, renderProject } from "./life.js";
import { renderDecision, renderDecisions } from "./decisions.js";
import { renderFuture, renderLearning } from "./growth.js";
import { renderCapture } from "./capture.js";
import { renderMemory } from "./memory.js";
import { renderRoutines } from "./routines.js";
import { renderProgress } from "./progress.js";
import { renderLoops, renderBadges } from "./today.js";

// GuideHub cockpit: shell (sign-in, navigation, hash router, Ask Jarvis), the Today view, and approvals. Life screens live in life.js.
// Rules (docs/guidehub/cockpit-design.md): all text goes through textContent (nothing from the API is ever parsed as HTML); the UI never
// computes progress/due/counts; outcomes resolve only from responses; there is no principal id anywhere in this file.

const root = document.getElementById("app");

onAuthLost(() => showSignIn("Your session ended. Sign in again."));

// ── Sign-in ──────────────────────────────────────────────────────────────
function showSignIn(message) {
  state.active = false; // stops every pending refresh: nothing calls the API while signed out
  root.replaceChildren();
  const msg = h("p", { class: "outcome bad", role: "alert", hidden: !message, text: message ?? "" });
  const input = h("input", { id: "pass", type: "password", autocomplete: "current-password", required: true, maxlength: "256" });
  const btn = h("button", { type: "submit", class: "primary", text: "Sign in" });
  const form = h("form", { class: "signin card" }, h("h1", { text: "GuideHub" }), h("p", { class: "muted", text: "Your Angel OS cockpit." }), msg,
    h("label", { for: "pass", text: "Passphrase" }), input, btn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    const r = await api("POST", "/session", { passphrase: input.value });
    input.value = "";
    if (r.status === 200) return boot();
    btn.disabled = false;
    msg.hidden = false;
    msg.textContent = r.status === 429 ? "Too many attempts. Try again later." : "Incorrect passphrase.";
  });
  root.append(h("main", { id: "main", class: "narrow" }, form));
  input.focus();
}

// ── Shell ────────────────────────────────────────────────────────────────
async function boot() {
  const s = await api("GET", "/session");
  if (!s.body?.authenticated) return showSignIn();
  state.me = s.body.me;
  state.timeZone = s.body.me?.principal?.timezone;
  renderShell();
}

function renderShell() {
  state.active = true;
  root.replaceChildren();
  const who = state.me?.principal?.name ?? "You";
  const signOut = h("button", { class: "link", text: "Sign out", onclick: async () => { await api("DELETE", "/session"); showSignIn(); } });
  const nav = h("nav", { class: "tabs", "aria-label": "Main" },
    h("a", { id: "nav-today", href: "#/today", text: "Today" }), h("a", { id: "nav-life", href: "#/life", text: "Life" }), h("a", { id: "nav-decisions", href: "#/decisions", text: "Decisions" }),
    h("a", { id: "nav-capture", href: "#/capture", text: "Capture" }), h("a", { id: "nav-routines", href: "#/routines", text: "Routines" }), h("a", { id: "nav-progress", href: "#/progress", text: "Progress" }), h("a", { id: "nav-memory", href: "#/memory", text: "Memory" }), h("a", { id: "nav-future", href: "#/future-self", text: "Future Self" }), h("a", { id: "nav-learning", href: "#/learning", text: "Learning" }),
    h("a", { id: "nav-approvals", href: "#/today", class: "badge-link", hidden: true }));
  const header = h("header", { class: "bar" }, h("strong", { class: "brand", text: "GuideHub" }), nav,
    h("span", { class: "who" }, who, state.me ? h("span", { class: "pill", text: state.me.interface.toLowerCase() }) : null), signOut);

  const answer = h("div", { class: "answer" });
  const ask = h("input", { id: "ask", type: "text", maxlength: "2000", placeholder: "Ask Jarvis — “what do you know about …”, “remind me tomorrow at 10 to …”", autocomplete: "off" });
  const askForm = h("form", { class: "ask", role: "search" }, h("label", { for: "ask", class: "sr", text: "Ask Jarvis" }), ask, h("button", { type: "submit", class: "primary", text: "Ask" }));
  askForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = ask.value.trim();
    if (!text) return;
    mount(answer, h("p", { class: "muted", text: "Thinking…" }));
    const r = await api("POST", "/api/jarvis", { input: text });
    const o = writeOutcome(r.status, r.body);
    // /api/jarvis answers 200 with a Result whatever its status; show the Result's own status honestly.
    const status = r.body?.status;
    const tone = status === "EXECUTED" ? "good" : status === "PENDING_APPROVAL" ? "warn" : "bad";
    mount(answer, r.status === 200 && r.body ? h("div", { class: `outcome ${tone}` }, h("p", { class: "pre", text: r.body.message ?? "" }), status === "PENDING_APPROVAL" ? h("p", { class: "muted" }, "It's waiting in ", h("a", { href: "#/today", text: "Approvals" }), ".") : null) : outcomeBox(o));
    if (status === "PENDING_APPROVAL" || status === "EXECUTED") { if (status === "EXECUTED") ask.value = ""; state.refresh?.(); }
  });

  root.append(header, h("main", { id: "main" }, askForm, answer, h("div", { id: "view" })));
  state.refresh = renderRoute;
  state.onPending = refreshApprovalBadge;
  renderRoute();
}

window.addEventListener("hashchange", () => {
  if (!state.active) return;
  const answer = document.querySelector(".answer");
  if (answer) mount(answer); // an answer belongs to the screen it was asked on; it does not follow you to another one
  renderRoute();
});

/** Hash router: #/today (default), #/life, #/life/projects/<id>. Unknown hashes are Today. */
function renderRoute() {
  const view = document.getElementById("view");
  if (!state.active || !view) return;
  const route = parseRoute(location.hash);
  for (const [id, on] of [["nav-today", route.view === "today"], ["nav-life", route.view === "life" || route.view === "project"], ["nav-decisions", route.view === "decisions" || route.view === "decision"], ["nav-capture", route.view === "capture"], ["nav-routines", route.view === "routines"], ["nav-progress", route.view === "progress"], ["nav-memory", route.view === "memory"], ["nav-future", route.view === "future"], ["nav-learning", route.view === "learning"]]) {
    const a = document.getElementById(id);
    if (a) on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  }
  if (route.view === "life") renderLife(view);
  else if (route.view === "project") renderProject(view, route.id);
  else if (route.view === "capture") renderCapture(view);
  else if (route.view === "memory") renderMemory(view);
  else if (route.view === "routines") renderRoutines(view);
  else if (route.view === "progress") renderProgress(view);
  else if (route.view === "future") renderFuture(view);
  else if (route.view === "learning") renderLearning(view);
  else if (route.view === "decisions") renderDecisions(view);
  else if (route.view === "decision") renderDecision(view, route.id);
  else renderToday(view);
  if (route.view !== "today") refreshApprovalBadge();
}

/** What is waiting for the owner is reachable from every screen. */
function setApprovalBadge(n) {
  const a = document.getElementById("nav-approvals");
  if (!a) return;
  a.hidden = !n;
  a.textContent = n ? `Approvals (${n})` : "";
}
async function refreshApprovalBadge() {
  if (!state.active) return;
  const r = await api("GET", "/api/approvals");
  const list = listFrom(r.status, r.body);
  if (list) setApprovalBadge(list.length);
}

function renderToday(view) {
  const briefing = h("div", { id: "briefing" });
  const side = h("div", { class: "side" }, h("div", { id: "approvals" }), h("div", { id: "reviews" }), h("div", { id: "cards" }), h("div", { id: "badges" }));
  const loops = h("div", { id: "loops" });
  mount(view, loops, h("div", { class: "grid" }, briefing, side));
  loadBriefing(); loadApprovals(); loadReviews(); loadCards(); renderLoops(loops); renderBadges(side.querySelector("#badges"));
}

// ── Today briefing ───────────────────────────────────────────────────────
async function loadBriefing(focus = "") {
  if (!state.active) return;
  const box = document.getElementById("briefing");
  if (!box) return;
  const r = await api("GET", `/api/context?q=${encodeURIComponent(focus)}`);
  if (r.status !== 200 || !r.body) return mount(box, section("Today", outcomeBox(writeOutcome(r.status, r.body))));
  const c = r.body;
  const focusInput = h("input", { id: "focus", type: "text", value: focus, maxlength: "500", placeholder: "Focus on… (optional)" });
  const focusForm = h("form", { class: "focus" }, h("label", { for: "focus", class: "sr", text: "Focus the briefing" }), focusInput, h("button", { type: "submit", text: "Refresh" }));
  focusForm.addEventListener("submit", (e) => { e.preventDefault(); loadBriefing(focusInput.value.trim()); });

  const notices = sectionNotices(c).map((n) => h("p", { class: `notice ${n.kind}` }, h("span", { "aria-hidden": "true", text: n.kind === "withheld" ? "🔒 " : "⚠ " }), n.text));

  const tasks = section("Open tasks", c.currentTasks?.length
    ? h("ul", { class: "list" }, c.currentTasks.map((t) => h("li", {}, h("span", { text: t.title }), h("span", { class: "muted", text: ` · ${t.status.toLowerCase().replace("_", " ")}${t.dueAt ? ` · due ${formatWhen(t.dueAt, state.timeZone)}` : ""}` }),
      h("button", { class: "small", "aria-label": `Mark done: ${t.title}`, text: "Done", onclick: (e) => completeTask(t.id, e.target) }))))
    : empty("No open tasks."));

  const life = section("Goals and projects",
    c.activeGoals?.length ? h("ul", { class: "list" }, c.activeGoals.map((g) => h("li", {}, h("span", { text: g.title }), h("span", { class: "muted", text: ` · ${g.horizon.toLowerCase()}` })))) : empty("No active goals."),
    c.activeProjects?.length ? h("ul", { class: "list" }, c.activeProjects.map((p) => h("li", {}, h("span", { text: p.name }), h("span", { class: "muted", text: ` · ${p.status.toLowerCase()} · ${p.tasks.open} open / ${p.tasks.done} done` })))) : null);

  const future = section("Aspirations", c.activeAspirations?.length
    ? h("ul", { class: "list" }, c.activeAspirations.map((a) => h("li", { class: "stack" }, h("strong", { text: a.title }), h("span", { class: "muted", text: `${a.current} → ${a.desired}` }), h("span", { class: a.progress === null ? "tag none" : "tag", text: progressLabel(a.progress) }))))
    : empty("No active aspirations."));

  const learning = section("Learning", c.activeLearning?.length ? h("ul", { class: "list" }, c.activeLearning.map((t) => h("li", { text: learningLine(t) }))) : empty("No active topics."));

  const mem = section("What Jarvis remembers", c.relevantMemories?.length
    ? h("ul", { class: "list" }, c.relevantMemories.map((m) => { const l = memoryLine(m); return h("li", { class: l.guess ? "guess" : "" }, h("span", { class: l.guess ? "tag guess" : "tag", text: l.label }), " ", l.text); }))
    : empty("Nothing relevant."));

  const know = c.relevantKnowledge?.length ? section("Knowledge", h("ul", { class: "list" }, c.relevantKnowledge.map((k) => h("li", { class: "stack" }, h("strong", { text: k.title }), h("span", { class: "muted", text: k.excerpt }), k.contradicted ? h("span", { class: "tag guess", text: "Contradicted by other knowledge" }) : null)))) : null;
  const dec = c.relevantDecisions?.length ? section("Decisions", h("ul", { class: "list" }, c.relevantDecisions.map((d) => h("li", {}, h("strong", { text: d.title }), h("span", { class: "muted", text: ` — ${d.decision}` }))))) : null;
  const act = section("Recently", c.recentActivity?.length ? h("ul", { class: "list" }, c.recentActivity.map((a) => h("li", {}, a.summary, h("span", { class: "muted", text: ` · ${formatWhen(a.occurredAt, state.timeZone)}` })))) : empty("Nothing yet."));

  mount(box, h("div", { class: "card head" }, h("h1", { text: "Today" }), h("p", { class: "muted", text: `As of ${formatWhen(c.generatedAt ?? new Date().toISOString(), state.timeZone)}. Everything here is data about you — Jarvis never treats it as instructions.` }), focusForm), ...notices, tasks, life, future, learning, mem, know, dec, act);
}

async function completeTask(id, btn) {
  btn.disabled = true;
  const r = await api("POST", "/api/actions/system.tasks/TASK_COMPLETE", { taskId: id });
  const o = writeOutcome(r.status, r.body);
  if (o.kind === "success" || o.kind === "notFound") return loadBriefing();
  btn.disabled = false;
  btn.after(h("span", { class: "outcome bad inline", role: "alert", text: ` ${o.text}` }));
}

// ── Approvals ────────────────────────────────────────────────────────────
async function loadApprovals() {
  if (!state.active) return;
  const box = document.getElementById("approvals");
  if (!box) return;
  const r = await api("GET", "/api/approvals");
  const list = listFrom(r.status, r.body);
  if (!list) return mount(box, section("Approvals", outcomeBox(writeOutcome(r.status, r.body))));
  setApprovalBadge(list.length);
  mount(box, section(`Approvals${list.length ? ` (${list.length})` : ""}`, list.length ? list.map(approvalCard) : empty("Nothing is waiting for you.")));
}

function approvalCard(a) {
  const result = h("div", { class: "result" });
  const details = h("pre", { class: "params", hidden: true });
  const detailsBtn = h("button", { class: "link", type: "button", "aria-expanded": "false", text: "Show exact parameters", onclick: async () => {
    if (!details.hidden) { details.hidden = true; detailsBtn.textContent = "Show exact parameters"; detailsBtn.setAttribute("aria-expanded", "false"); return; }
    const r = await api("GET", `/api/approvals/${a.id}`);
    details.textContent = r.status === 200 ? JSON.stringify(r.body.parameters ?? {}, null, 2) : "Couldn't load the details.";
    details.hidden = false; detailsBtn.textContent = "Hide parameters"; detailsBtn.setAttribute("aria-expanded", "true");
  } });
  const buttons = [];
  const decide = async (decision) => {
    buttons.forEach((b) => (b.disabled = true));
    const r = await api("POST", `/api/approvals/${a.id}/${decision}`, {});
    const o = approvalOutcome(r.status, r.body, decision);
    mount(result, outcomeBox(o));
    if (o.done) { detailsBtn.remove(); details.remove(); setTimeout(() => { loadApprovals(); if (decision === "approve") loadBriefing(); }, 1800); }
    else buttons.forEach((b) => (b.disabled = false));
  };
  buttons.push(h("button", { class: "primary small", text: "Approve", "aria-label": `Approve: ${a.summary}`, onclick: () => decide("approve") }), h("button", { class: "small", text: "Deny", "aria-label": `Deny: ${a.summary}`, onclick: () => decide("deny") }));
  return h("article", { class: "approval" }, h("p", { class: "pre", text: a.summary }),
    h("p", { class: "muted" }, h("span", { class: `tag risk-${a.risk.toLowerCase()}`, text: riskLabel(a.risk) }), ` · expires ${countdown(a.expiresAt, Date.now())}`),
    h("div", { class: "actions" }, ...buttons, detailsBtn), details, result);
}

// ── Due decision reviews ─────────────────────────────────────────────────
async function loadReviews() {
  if (!state.active) return;
  const box = document.getElementById("reviews");
  if (!box) return;
  const r = await api("GET", "/api/decisions?dueForReview=true");
  const list = listFrom(r.status, r.body);
  if (!list?.length) return box.replaceChildren();
  mount(box, section("Time to look back", ...list.slice(0, 3).map(reviewCard)));
}

function reviewCard(d) {
  const outcome = h("textarea", { id: `o-${d.id}`, rows: "3", required: true, maxlength: "2000" });
  const lesson = h("textarea", { id: `l-${d.id}`, rows: "2", maxlength: "2000" });
  const result = h("div", { class: "result" });
  const btn = h("button", { type: "submit", class: "primary small", text: "Record" });
  const form = h("form", { class: "stack" },
    h("p", {}, h("strong", { text: d.title }), h("span", { class: "muted", text: ` — ${d.decision}` })),
    d.expected ? h("p", { class: "muted", text: `You expected: ${d.expected}` }) : null,
    h("label", { for: `o-${d.id}`, text: "What actually happened?" }), outcome,
    h("label", { for: `l-${d.id}`, text: "What did you learn? (optional)" }), lesson, btn, result);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    const body = { decisionId: d.id, outcome: outcome.value.trim() };
    if (lesson.value.trim()) body.lesson = lesson.value.trim();
    const r = await api("POST", "/api/actions/system.decisions/DECISION_REVIEW", body);
    const o = writeOutcome(r.status, r.body);
    mount(result, outcomeBox(o));
    if (o.kind === "success" || o.kind === "notFound" || o.kind === "invalid") setTimeout(loadReviews, 1500);
    if (o.kind !== "success") btn.disabled = false;
  });
  return form;
}

// ── Due recall cards ─────────────────────────────────────────────────────
async function loadCards() {
  if (!state.active) return;
  const box = document.getElementById("cards");
  if (!box) return;
  const r = await api("GET", "/api/learning/due?limit=1");
  const list = listFrom(r.status, r.body);
  if (!list?.length) return box.replaceChildren();
  const card = list[0];
  const answer = h("p", { class: "pre answer-text", hidden: true, text: card.answer });
  const grades = h("div", { class: "actions", hidden: true }, GRADES.map((g) => h("button", { class: "small", text: g.label, onclick: async (e) => {
    e.target.parentElement.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const res = await api("POST", "/api/actions/system.learning/CARD_REVIEW", { cardId: card.id, grade: g.value });
    const o = writeOutcome(res.status, res.body);
    if (o.kind === "success" || o.kind === "notFound") return loadCards();
    box.append(outcomeBox(o));
  } })));
  const reveal = h("button", { class: "primary small", text: "Show answer", onclick: (e) => { answer.hidden = false; grades.hidden = false; e.target.hidden = true; grades.querySelector("button")?.focus(); } });
  mount(box, section("Review a card", h("p", { class: "pre", text: card.prompt }), reveal, answer, grades, h("p", { class: "muted", text: "Grade it yourself — nothing here scores you." })));
}

boot();
