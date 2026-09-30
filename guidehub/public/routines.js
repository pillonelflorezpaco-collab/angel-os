import { WEEKDAYS, ROUTINE_KINDS, buildRoutineBody, canCheckRoutine, describeRoutineDays, lifeOutcome, routineKindLabel, routineStateLabel } from "./lib.js";
import { api, empty, h, mount, outcomeBox, section, state } from "./ui.js";
import { guarded, nextId, pill, run } from "./kit.js";

// Routines: YOUR plan for recurring parts of the day (a meal, a habit, a block of time) and a plain record of whether it was done.
// Angel OS holds the plan you wrote and shows it on your clock; it doesn't make a plan up, and a time that passed with nothing recorded
// is "not recorded yet" — never a verdict. Every change is an ordinary action (permissions, approvals and audit apply).

const SK = "system.routines";
let token = 0;
const data = (r) => (r.status === 200 && r.body?.status === "EXECUTED" ? r.body.data : null);
const failure = (r) => outcomeBox(lifeOutcome(r.status === 200 ? 403 : r.status, r.body));

function todayView(plan, reload) {
  if (!plan.hasAnyRoutine) return empty("You haven't set up any routines yet, so there is no plan to show. Add one below.");
  if (!plan.items.length) return empty(`Nothing is planned for ${plan.weekday}.`);
  return h("ul", { class: "list" }, plan.items.map((i) => {
    const status = h("span", { class: "result" });
    const mark = (s) => async (e) => { e.target.disabled = true; const o = await run(status, SK, "ROUTINE_CHECK", { routineId: i.routineId, status: s }, { rerender: false }); if (o.kind === "success") reload(); else e.target.disabled = false; };
    return h("li", { class: "stack", "data-routine": i.routineId, "data-state": i.state },
      h("span", {}, h("strong", { text: `${i.time} — ${i.title}` }), " ", pill(routineKindLabel(i.kind)), " ", pill(routineStateLabel(i))),
      i.details ? h("span", { text: i.details }) : null,
      i.checkNote ? h("span", { class: "muted", text: `Note: ${i.checkNote}` }) : null,
      canCheckRoutine(i) ? h("span", { class: "actions" }, h("button", { class: "small primary", "aria-label": `Mark done: ${i.title}`, text: "Done", onclick: mark("DONE") }), h("button", { class: "small", "aria-label": `Skip: ${i.title}`, text: "Skip today", onclick: mark("SKIPPED") })) : null, status);
  }));
}

function editForm(r, reload) {
  const status = h("div", { class: "result" });
  const dId = nextId("rd"), tId = nextId("rt");
  const details = h("textarea", { id: dId, rows: "2", maxlength: "2000" }); details.value = r.details ?? "";
  const time = h("input", { id: tId, type: "time" }); time.value = r.timeOfDay;
  const form = h("form", { class: "stack form" }, h("div", { class: "field" }, h("label", { for: dId, text: "Details (what to eat, what to do)" }), details), h("div", { class: "field" }, h("label", { for: tId, text: "Time" }), time), h("button", { type: "submit", class: "small primary", text: "Save changes" }), status);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { routineId: r.id };
    if (details.value.trim() !== (r.details ?? "")) body.details = details.value.trim() || null;
    if (time.value && time.value !== r.timeOfDay) body.timeOfDay = time.value;
    if (Object.keys(body).length === 1) return mount(status, outcomeBox({ tone: "neutral", kind: "none", text: "Nothing changed." }));
    const o = await run(status, SK, "ROUTINE_UPDATE", body, { rerender: false });
    if (o.kind === "success") reload();
  });
  return h("details", {}, h("summary", { text: "Edit" }), form);
}

function routineRow(r, reload) {
  const box = h("div", { class: "result" });
  const setTo = (to, label) => h("button", { class: "small", text: label, onclick: async (e) => { e.target.disabled = true; const o = await run(box, SK, "ROUTINE_SET_STATUS", { routineId: r.id, status: to }, { rerender: false }); if (o.kind === "success") reload(); else e.target.disabled = false; } });
  return h("li", { class: "stack", "data-routine-row": r.id },
    h("span", {}, h("strong", { text: r.title }), " ", pill(routineKindLabel(r.kind)), r.status === "PAUSED" ? " " : null, r.status === "PAUSED" ? pill("Paused") : null),
    h("span", { class: "muted", text: `${describeRoutineDays(r.daysOfWeek)} at ${r.timeOfDay}${r.durationMinutes ? ` · ${r.durationMinutes} min` : ""}` }),
    r.details ? h("span", { text: r.details }) : null,
    h("span", { class: "actions" }, r.status === "PAUSED" ? setTo("ACTIVE", "Resume") : setTo("PAUSED", "Pause"),
      guarded({ label: "Archive", confirmLabel: "Archive it", onConfirm: (_t, b) => run(b, SK, "ROUTINE_SET_STATUS", { routineId: r.id, status: "ARCHIVED" }, { rerender: false }).then((o) => { if (o.kind === "success") reload(); return o; }) })),
    editForm(r, reload), box);
}

function addForm(reload) {
  const status = h("div", { class: "result" });
  const errors = h("div", { role: "alert" });
  const ids = { title: nextId("ra"), kind: nextId("ra"), details: nextId("ra"), time: nextId("ra"), dur: nextId("ra") };
  const title = h("input", { id: ids.title, type: "text", maxlength: "200" });
  const kind = h("select", { id: ids.kind }, ROUTINE_KINDS.map((k) => h("option", { value: k.value, text: k.label })));
  kind.value = "OTHER";
  const details = h("textarea", { id: ids.details, rows: "2", maxlength: "2000" });
  const time = h("input", { id: ids.time, type: "time" });
  const dur = h("input", { id: ids.dur, type: "text", inputmode: "numeric", maxlength: "4" });
  const dayBoxes = WEEKDAYS.map((d) => { const id = nextId("rday"); return { d, el: h("input", { id, type: "checkbox" }), id }; });
  const field = (id, label, el, hint) => h("div", { class: "field" }, h("label", { for: id, text: label }), el, hint ? h("p", { class: "muted hint", text: hint }) : null);
  const form = h("form", { class: "stack form" }, field(ids.title, "Name", title), field(ids.kind, "Kind", kind), field(ids.details, "Details (optional)", details, "In your own words — for a meal, what to eat; for a habit, what to do."),
    h("fieldset", {}, h("legend", { text: "Days" }), h("div", { class: "actions" }, dayBoxes.map(({ d, el, id }) => h("span", {}, el, " ", h("label", { for: id, text: d.label }))))),
    field(ids.time, "Time", time), field(ids.dur, "Length in minutes (optional)", dur), errors, h("button", { type: "submit", class: "primary", text: "Add routine" }), status);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { body, errors: errs } = buildRoutineBody({ title: title.value, kind: kind.value, details: details.value, timeOfDay: time.value, durationMinutes: dur.value }, dayBoxes.filter((x) => x.el.checked).map((x) => x.d.value));
    if (errs.length) return mount(errors, h("ul", { class: "errors" }, errs.map((t) => h("li", { text: t }))));
    mount(errors);
    const o = await run(status, SK, "ROUTINE_CREATE", body, { rerender: false });
    if (o.kind === "success") reload();
  });
  return form;
}

export async function renderRoutines(view) {
  const mine = ++token;
  mount(view, h("p", { class: "muted", text: "Loading…" }));
  const [todayR, listR] = await Promise.all([api("GET", "/api/routines/today"), api("GET", "/api/routines")]);
  if (mine !== token || !state.active) return;
  const reload = () => renderRoutines(view);
  const plan = data(todayR), list = data(listR);
  mount(view, h("h1", { text: "Routines" }),
    h("p", { class: "muted", text: "Your own plan for meals, habits and blocks of time. Angel OS shows it on your clock; it doesn't make a plan up, and a time that passed with nothing recorded is “not recorded yet”, never a verdict." }),
    section(plan ? `Today — ${plan.weekday}` : "Today", plan ? todayView(plan, reload) : failure(todayR)),
    section("All routines", Array.isArray(list) ? (list.length ? h("ul", { class: "list" }, list.map((r) => routineRow(r, reload))) : empty("No routines yet.")) : failure(listR)),
    section("Add a routine", addForm(reload)));
}
