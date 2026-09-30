import { buildCaptureConfirmBody, captureCanSave, captureOutcomeLabel, captureStatusLabel, captureTypeLabel, lifeOutcome } from "./lib.js";
import { api, empty, h, mount, outcomeBox, section, state } from "./ui.js";
import { nextId, pill } from "./kit.js";

// Capture: say what happened, decided or learned. An interpreter proposes a DRAFT; NOTHING is saved until you confirm, and every confirmed
// item is an ordinary action (permissions, approvals and audit apply as everywhere). The proposal text is the server's; this screen only
// sends back which items you ticked — never words, ids or labels.

let token = 0;

function outcomesView(outcomes) {
  return h("ul", { class: "list" }, outcomes.map((o) => h("li", { class: "stack", "data-outcome": o.status },
    h("span", {}, pill(captureTypeLabel(o.type)), " ", h("strong", { text: captureOutcomeLabel(o.status) })), h("span", { class: "muted", text: o.message }),
    o.status === "PENDING_APPROVAL" ? h("a", { href: "#/today", text: "See approvals" }) : null)));
}

function proposalView(p, reset) {
  const checks = new Map();
  const status = h("div", { class: "result" });
  const rows = p.items.map((i) => {
    let box = null;
    if (captureCanSave(i)) {
      const id = nextId("cap");
      box = h("input", { id, type: "checkbox", checked: true, "aria-label": `Save item ${i.index + 1}` });
      checks.set(i.index, box);
    }
    return h("li", { class: "stack", "data-item": String(i.index), "data-status": i.status },
      h("span", {}, box, box ? " " : null, pill(captureTypeLabel(i.type)), " ", h("strong", { text: i.summary })),
      h("span", { class: "muted", text: captureStatusLabel(i.status) }),
      i.note ? h("span", { class: "muted", text: i.note }) : null,
      i.question ? h("span", { class: "notice", text: `${i.question.question}${i.question.options?.length ? ` (${i.question.options.join(" · ")})` : ""}` }) : null,
      i.dependsOn?.length ? h("span", { class: "muted", text: `Needs ${i.dependsOn.map((d) => `item ${d + 1}`).join(", ")} to be saved as its evidence.` }) : null,
      i.modelConfidence !== null && i.modelConfidence !== undefined ? h("span", { class: "muted", text: `The interpreter's own confidence: ${i.modelConfidence} (not evidence, and not saved).` }) : null);
  });
  const save = h("button", { class: "primary", text: "Confirm selected" });
  const cancel = h("button", { type: "button", text: "Cancel — save nothing" });
  const done = (view) => { mount(status, view); save.disabled = true; cancel.disabled = true; };
  save.addEventListener("click", async () => {
    save.disabled = true;
    const body = buildCaptureConfirmBody([...checks].filter(([, el]) => el.checked).map(([i]) => i));
    const r = await api("POST", `/api/capture/${p.proposalId}/confirm`, body);
    if (r.status === 200 && r.body?.status === "EXECUTED") return done(h("div", { class: "stack" }, h("h3", { text: "Result" }), outcomesView(r.body.data.outcomes)));
    save.disabled = false;
    mount(status, outcomeBox(lifeOutcome(r.status, r.body)));
  });
  cancel.addEventListener("click", async () => {
    const r = await api("POST", `/api/capture/${p.proposalId}/cancel`, {});
    if (r.status === 200) return done(outcomeBox({ tone: "neutral", kind: "cancelled", text: "Cancelled. Nothing was saved." }));
    mount(status, outcomeBox(lifeOutcome(r.status, r.body)));
  });
  return h("div", { class: "stack", "data-proposal": p.proposalId },
    h("p", { class: "notice", role: "status", text: "Nothing has been saved yet." }),
    p.failClosed ? h("p", { class: "outcome bad", role: "alert", text: `${p.failClosed} Nothing was proposed.` }) : null,
    rows.length ? h("ul", { class: "list" }, rows) : (p.failClosed ? null : empty("Nothing that can be saved was found in that sentence.")),
    p.clarifications?.length ? h("div", { class: "stack" }, h("h3", { text: "Jarvis needs to know" }), h("ul", { class: "list" }, p.clarifications.map((c) => h("li", { class: "stack" }, h("span", { text: c.question }), c.options?.length ? h("span", { class: "muted", text: c.options.join(" · ") }) : null)))) : null,
    p.rejected?.length ? h("div", { class: "stack" }, h("h3", { text: "Not understood" }), h("ul", { class: "list" }, p.rejected.map((r) => h("li", { class: "muted", text: `Item ${r.index + 1}: ${r.reason}` })))) : null,
    h("span", { class: "actions" }, save, cancel, h("button", { type: "button", class: "link", text: "Start over", onclick: reset })), status);
}

export function renderCapture(view) {
  const mine = ++token;
  const out = h("div");
  const status = h("div", { class: "result" });
  const id = nextId("ct");
  const text = h("textarea", { id, rows: "4", maxlength: "4000", placeholder: "Today I worked three hours on… I decided… I learned…" });
  const go = h("button", { type: "submit", class: "primary", text: "Interpret" });
  const reset = () => { mount(out); mount(status); text.value = ""; go.disabled = false; text.focus(); };
  const form = h("form", { class: "stack form" }, h("div", { class: "field" }, h("label", { for: id, text: "What happened, what did you decide, what did you learn?" }), text,
    h("p", { class: "muted hint", text: "An interpreter turns this into a draft. You will see exactly what would be saved and can change your mind." })), go, status);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = text.value.trim();
    if (!t) return mount(status, outcomeBox({ tone: "bad", kind: "invalid", text: "Write a sentence first." }));
    go.disabled = true;
    mount(status, h("p", { class: "muted", text: "Interpreting…" }));
    const r = await api("POST", "/api/capture", { text: t });
    if (mine !== token || !state.active) return;
    go.disabled = false;
    if (r.status === 200 && r.body?.status === "EXECUTED") { mount(status); go.disabled = true; return mount(out, proposalView(r.body.data, reset)); }
    mount(status, r.status === 503 ? outcomeBox({ tone: "warn", kind: "unavailable", text: r.body?.message ?? "No interpreter is connected yet." }) : outcomeBox(lifeOutcome(r.status, r.body)));
  });
  mount(view, h("h1", { text: "Capture" }), section("Say it in your own words", form), out);
}
