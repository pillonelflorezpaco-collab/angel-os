import { buildBody, formatDateOnly, lifeOutcome, listFrom } from "./lib.js";
import { api, h, mount, outcomeBox, state } from "./ui.js";

// Shared building blocks for the write screens (Life, Decisions): one way to run an action and show its honest outcome, labelled forms,
// guarded terminal actions, and small text helpers. Nothing here parses markup or holds a token.

let uid = 0;
export const nextId = (p) => `${p}-${++uid}`;
export const act = (skill, name, body) => api("POST", `/api/actions/${skill}/${name}`, body);
export const okOrList = (r) => listFrom(r.status, r.body);

/** Run a write, show its honest outcome in `box`, and re-render only on success. Returns the outcome. */
export async function run(box, skill, name, body, { rerender = true } = {}) {
  mount(box, h("p", { class: "muted", text: "Working…" }));
  const r = await act(skill, name, body);
  const o = lifeOutcome(r.status, r.body);
  mount(box, outcomeBox(o));
  if (o.kind === "pending") state.onPending?.(); // what is waiting for the owner is visible from every screen at once
  if (o.kind === "success" && rerender) setTimeout(() => state.refresh?.(), 600);
  return { ...o, data: r.body?.data };
}

/** A labelled form. fields: {name,label,type: text|textarea|date|select,required,options,value,maxlength,hint} */
export function formCard({ fields, submit, onSubmit, dates = [], compact = false }) {
  const status = h("div", { class: "result" });
  const inputs = {};
  const rows = fields.map((f) => {
    const id = nextId("f");
    let input;
    if (f.type === "textarea") input = h("textarea", { id, rows: "2", maxlength: String(f.maxlength ?? 2000), required: f.required });
    else if (f.type === "select") input = h("select", { id, required: f.required }, h("option", { value: "", text: f.placeholder ?? "—" }), (f.options ?? []).map((o) => h("option", { value: o.value, text: o.label })));
    else input = h("input", { id, type: f.type === "date" ? "date" : "text", maxlength: String(f.maxlength ?? 200), required: f.required });
    if (f.value !== undefined && f.value !== null) input.value = f.value;
    inputs[f.name] = input;
    return h("div", { class: "field" }, h("label", { for: id, text: f.label + (f.required ? "" : " (optional)") }), input, f.hint ? h("p", { class: "muted hint", text: f.hint }) : null);
  });
  const btn = h("button", { type: "submit", class: compact ? "small primary" : "primary", text: submit });
  const form = h("form", { class: "stack form" }, ...rows, btn, status);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    const { body, invalid } = buildBody(values, dates);
    if (invalid.length) return mount(status, outcomeBox({ tone: "bad", kind: "invalid", text: "That date isn't valid." }));
    btn.disabled = true;
    const o = await onSubmit(body, status);
    btn.disabled = false;
    if (o?.kind === "success") form.reset();
  });
  return form;
}

/** Something irreversible needs a second, explicit click (and optionally a written reason). */
export function guarded({ label, confirmLabel, ask, onConfirm, small = true }) {
  const box = h("span", { class: "guard" });
  const status = h("div", { class: "result" });
  const show = () => {
    const btn = h("button", { class: small ? "small" : "", text: label, onclick: () => open() });
    mount(box, btn);
  };
  const open = () => {
    const id = nextId("g");
    const input = ask ? h("textarea", { id, rows: "2", maxlength: "1000", required: ask.required }) : null;
    const go = h("button", { class: "small primary", text: confirmLabel ?? label });
    const cancel = h("button", { class: "small", type: "button", text: "Cancel", onclick: show });
    const form = h("form", { class: "stack inline-guard" }, ask ? h("label", { for: id, text: ask.label }) : h("p", { class: "muted", text: "This can't be undone." }), input, h("span", { class: "actions" }, go, cancel));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      go.disabled = true;
      const text = input?.value.trim();
      if (ask?.required && !text) { go.disabled = false; return mount(status, outcomeBox({ tone: "bad", kind: "invalid", text: "Please write a reason." })); }
      const o = await onConfirm(text, status);
      if (o?.kind !== "success") go.disabled = false;
    });
    mount(box, form);
    input?.focus();
  };
  show();
  return h("span", { class: "guarded" }, box, status);
}

export const pill = (text, extra = "") => h("span", { class: `tag ${extra}`.trim(), text });
export const dateBit = (iso, prefix) => (iso ? h("span", { class: "muted", text: ` · ${prefix} ${formatDateOnly(iso)}` }) : null);

