import { MEMORY_FILTERS, canConfirmMemory, canRetractMemory, formatDateOnly, lifeOutcome, memoryStatusLabel, memoryTypeLabel, provenanceLabel } from "./lib.js";
import { api, empty, h, mount, outcomeBox, section, state } from "./ui.js";
import { guarded, nextId, pill, run } from "./kit.js";

// Memory & Knowledge: SEE the second brain. Read-mostly. Memory keeps its type on screen (an inference is never dressed up as a fact);
// the only writes are the two the owner already has as actions — confirm an unconfirmed inference, or retract something that was wrong (the record is kept).

let token = 0;
const data = (r) => (r.status === 200 && r.body?.status === "EXECUTED" ? r.body.data : null);

function memoryRow(m, reload) {
  const status = m.status && m.status !== "ACTIVE" ? pill(memoryStatusLabel(m.status)) : null;
  const actions = [];
  if (canConfirmMemory(m)) actions.push(guarded({ label: "Confirm this is right", confirmLabel: "Yes, it's right", onConfirm: (_t, box) => run(box, "system.memory", "MEMORY_CONFIRM", { memoryId: m.id }, { rerender: false }).then((o) => { if (o.kind === "success") reload(); return o; }) }));
  if (canRetractMemory(m)) actions.push(guarded({ label: "Mark as wrong", confirmLabel: "Mark as wrong", ask: { label: "Why is it wrong or no longer true?", required: true }, onConfirm: (t, box) => run(box, "system.memory", "MEMORY_RETRACT", { memoryId: m.id, reason: t }, { rerender: false }).then((o) => { if (o.kind === "success") reload(); return o; }) }));
  return h("li", { class: m.type === "INFERENCE" ? "stack guess" : "stack", "data-memory": m.id, "data-type": m.type },
    h("span", {}, pill(memoryTypeLabel(m.type)), " ", status, status ? " " : null, h("span", { text: m.content })),
    h("span", { class: "muted", text: [provenanceLabel(m.provenance), m.subject ? `about ${m.subject}` : null, m.occurredAt ? `happened ${formatDateOnly(m.occurredAt)}` : null, `saved ${formatDateOnly(m.createdAt)}`].filter(Boolean).join(" · ") }),
    m.retractedReason ? h("span", { class: "muted", text: `Marked wrong because: ${m.retractedReason}` }) : null,
    actions.length ? h("span", { class: "actions" }, actions) : null);
}

function knowledgeRow(k) {
  return h("li", { class: "stack", "data-knowledge": k.id },
    h("span", {}, pill(String(k.kind ?? "knowledge").toLowerCase()), " ", h("strong", { text: k.title }), k.contradicted ? " " : null, k.contradicted ? pill("Marked as contradicted") : null),
    k.excerpt ? h("span", { text: k.excerpt }) : null,
    h("span", { class: "muted", text: `About the world, not about you${k.confidence !== undefined && k.confidence !== null ? ` · confidence recorded: ${k.confidence}` : ""}` }));
}

export function renderMemory(view) {
  const mine = ++token;
  const results = h("div", { class: "stack" });
  const tabId = nextId("mt");
  const which = h("select", { id: tabId }, h("option", { value: "memory", text: "Memory — about you" }), h("option", { value: "knowledge", text: "Knowledge — about the world" }));
  const qId = nextId("mq");
  const q = h("input", { id: qId, type: "text", maxlength: "200", placeholder: "Search (empty = most recent)" });
  const typeId = nextId("mf");
  const type = h("select", { id: typeId }, h("option", { value: "", text: "Any type" }), MEMORY_FILTERS.map((t) => h("option", { value: t, text: memoryTypeLabel(t) })));
  const go = h("button", { type: "submit", class: "primary", text: "Search" });
  const form = h("form", { class: "stack form" }, h("div", { class: "field" }, h("label", { for: tabId, text: "Look in" }), which),
    h("div", { class: "field" }, h("label", { for: qId, text: "Search" }), q), h("div", { class: "field", id: "type-field" }, h("label", { for: typeId, text: "Type" }), type), go);
  const sync = () => { form.querySelector("#type-field").hidden = which.value !== "memory"; };
  which.addEventListener("change", () => { sync(); load(); });
  sync();

  async function load() {
    mount(results, h("p", { class: "muted", text: "Loading…" }));
    const memory = which.value === "memory";
    const params = new URLSearchParams();
    if (q.value.trim()) params.set("q", q.value.trim());
    if (memory && type.value) params.set("type", type.value);
    const base = memory ? "/api/memory/search" : "/api/knowledge/search"; // two literal routes, each on the proxy allow-list
    const path = params.toString() ? `${base}?${params}` : base;
    const r = await api("GET", path);
    if (mine !== token || !state.active) return;
    const list = data(r);
    if (!Array.isArray(list)) return mount(results, outcomeBox(lifeOutcome(r.status === 200 ? 403 : r.status, r.body)));
    mount(results, list.length
      ? [h("p", { class: "muted", text: `${list.length} shown${list.length >= 20 ? " (the most relevant or recent)" : ""}.` }), h("ul", { class: "list" }, list.map((m) => (memory ? memoryRow(m, load) : knowledgeRow(m))))]
      : empty(q.value.trim() || type.value ? "Nothing matches that." : `No ${memory ? "memories" : "knowledge"} are recorded yet.`));
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); load(); });
  mount(view, h("h1", { text: "Memory & Knowledge" }),
    h("p", { class: "muted", text: "Your second brain, as recorded. Memory is about you and your history; knowledge is about the world. Each record keeps its type — an inference is never shown as a fact." }),
    section("Browse and search", form), results);
  load();
}
