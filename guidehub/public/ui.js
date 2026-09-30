import { CSRF, writeOutcome } from "./lib.js";

// Shared UI plumbing. The rules from docs/guidehub/cockpit-design.md live here so every screen gets them for free:
// text-only rendering, ONE fetch wrapper (adds the CSRF header, never a token), ONE place children are swapped in, one honest outcome component.

export const state = { me: null, timeZone: undefined, active: false, refresh: null, onPending: null };

let authLost = () => {};
/** The shell registers what to do when a call returns 401 (show the sign-in screen). */
export function onAuthLost(fn) { authLost = fn; }

/** Element helper. Children are strings (→ text nodes) or nodes. It never parses markup: API text can only ever become text. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** SVG element helper, same rule as h(): text only ever becomes text (textContent), attributes are set as attributes — never markup, never a style attribute. */
export function svg(tag, props = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c);
  return el;
}

export async function api(method, path, body) {
  const init = { method, headers: { ...CSRF, Accept: "application/json" }, credentials: "same-origin" };
  if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, init); } catch { return { status: 502, body: { error: "The service is unavailable right now." } }; }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && path !== "/session") authLost();
  return { status: res.status, body: parsed };
}

/** The ONLY place children are swapped in: null/undefined/false sections are dropped (a raw replaceChildren would print "null"). */
export const mount = (box, ...nodes) => box.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));

export function outcomeBox(outcome) {
  return h("p", { class: `outcome ${outcome.tone}`, role: outcome.tone === "bad" ? "alert" : "status" }, h("span", { class: "outcome-icon", "aria-hidden": "true", text: { good: "✓", warn: "⏳", bad: "✗", neutral: "•" }[outcome.tone] }), " ", outcome.text,
    outcome.kind === "pending" ? h("span", {}, " ", h("a", { href: "#/today", text: "See approvals" })) : null);
}

export const section = (title, ...body) => h("section", { class: "card" }, h("h2", { text: title }), ...body);
export const empty = (text) => h("p", { class: "muted", text });
export { writeOutcome };
