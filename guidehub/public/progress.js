import { barSegments, calendarReadout, calendarSummary, calendarWeeks, formatDateOnly, lifeOutcome, monthLabels, projectLine, stateReadout, timelinePosition } from "./lib.js";
import { api, empty, h, mount, outcomeBox, section, state, svg } from "./ui.js";
import { pill } from "./kit.js";

// Progress: three honest pictures of what was RECORDED — an activity calendar, a Future Self timeline, a goals-to-projects map.
// Every number and date comes from the server; this file only lays them out. Shade = a bucket of a real count (always shown in words too),
// nothing is scored, averaged or projected, and an empty day is "nothing recorded", never a bad day. Colours come from classes (CSS), never inline styles.

let token = 0;
const data = (r) => (r.status === 200 && r.body?.status === "EXECUTED" ? r.body.data : null);
const CELL = 14, GAP = 3, LEFT = 30, TOP = 16;

function calendarView(cal, levels) {
  const readout = h("p", { class: "readout", "aria-live": "polite", text: "Hover or focus a day to read it." });
  const weeks = calendarWeeks(cal.days);
  const W = LEFT + weeks.length * (CELL + GAP), H = TOP + 7 * (CELL + GAP);
  const cells = [];
  weeks.forEach((w, col) => w.forEach((d, row) => {
    if (!d) return;
    const say = () => { readout.textContent = calendarReadout(d); };
    cells.push(svg("rect", { class: `cell level-${d.level}`, x: LEFT + col * (CELL + GAP), y: TOP + row * (CELL + GAP), width: CELL, height: CELL, rx: 3, tabindex: "0", role: "img", "aria-label": calendarReadout(d), "data-day": d.day, "data-level": d.level, onpointerenter: say, onfocus: say }));
  }));
  const months = monthLabels(weeks).map((m) => svg("text", { class: "axis-text", x: LEFT + m.col * (CELL + GAP), y: 11, text: m.label }));
  const dows = ["Mon", "Wed", "Fri"].map((t, i) => svg("text", { class: "axis-text", x: 0, y: TOP + [0, 2, 4][i] * (CELL + GAP) + 11, text: t }));
  const chart = svg("svg", { class: "viz-svg calendar-svg", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": "Activity calendar: one square per day, shaded by how many things were recorded" }, months, dows, cells);
  const legend = h("p", { class: "legend" }, "Recorded per day: ", levels.map((l) => h("span", { class: "legend-item" }, (() => { const s = svg("svg", { class: "swatch", viewBox: "0 0 14 14", width: 14, height: 14, "aria-hidden": "true" }, svg("rect", { class: `cell level-${l.level}`, x: 0, y: 0, width: 14, height: 14, rx: 3 })); return s; })(), ` ${l.label}  `)));
  const days = cal.days.filter((d) => d.total > 0).reverse();
  const table = h("details", {}, h("summary", { text: "Show as a table" }),
    days.length ? h("table", { class: "viz-table" }, h("thead", {}, h("tr", {}, h("th", { text: "Day" }), h("th", { text: "Recorded" }))), h("tbody", {}, days.map((d) => h("tr", {}, h("td", { text: d.day }), h("td", { text: calendarReadout(d).split(" — ")[1] }))))) : empty("Nothing is recorded in this window."));
  return h("div", { class: "stack viz" }, h("p", { text: calendarSummary(cal) }), chart, legend, readout, table);
}

const TW = 640, TH = 44, PAD = 14;
function timelineView(t) {
  const lines = t.lines.filter((l) => l.points.length);
  if (!lines.length) return empty("No Future Self states are recorded yet.");
  const range = h("p", { class: "muted", text: `From ${formatDateOnly(t.from)} to today. Dots sit at the dates states were recorded; nothing is drawn between them.` });
  return h("div", { class: "stack viz" }, range, lines.map((l) => {
    const readout = h("p", { class: "readout", "aria-live": "polite", text: "Hover or focus a dot to read that state." });
    const dots = l.points.map((p, i) => {
      const x = PAD + timelinePosition(p.at, t.from, t.to) * (TW - 2 * PAD);
      const say = () => { readout.textContent = stateReadout(p); };
      return svg("circle", { class: p.basis === "INITIAL" ? "point point-initial" : "point point-evidenced", cx: x, cy: TH / 2, r: i === l.points.length - 1 ? 8 : 6, tabindex: "0", role: "img", "aria-label": stateReadout(p), "data-basis": p.basis, onpointerenter: say, onfocus: say });
    });
    const axis = svg("line", { class: "axis-line", x1: PAD, x2: TW - PAD, y1: TH / 2, y2: TH / 2 });
    const n = l.points.length, ev = l.points.filter((p) => p.basis !== "INITIAL").length;
    return h("div", { class: "stack", "data-aspiration": l.aspirationId },
      h("h3", { text: l.title }), h("p", { class: "muted", text: `${n} state${n === 1 ? "" : "s"} recorded, ${ev} updated with evidence.` }),
      svg("svg", { class: "viz-svg", viewBox: `0 0 ${TW} ${TH}`, role: "group", "aria-label": `Timeline for ${l.title}` }, axis, dots), readout);
  }), h("p", { class: "legend" }, h("span", { class: "legend-item" }, svg("svg", { class: "swatch", viewBox: "0 0 14 14", width: 14, height: 14, "aria-hidden": "true" }, svg("circle", { class: "point point-initial", cx: 7, cy: 7, r: 5 })), " starting statement  "),
    h("span", { class: "legend-item" }, svg("svg", { class: "swatch", viewBox: "0 0 14 14", width: 14, height: 14, "aria-hidden": "true" }, svg("circle", { class: "point point-evidenced", cx: 7, cy: 7, r: 5 })), " updated with evidence  "), "The larger dot is the latest."));
}

const BW = 220;
function mapView(map) {
  const all = [...map.goals.flatMap((g) => g.projects), ...map.unassigned];
  if (!all.length && !map.goals.length) return empty("No goals or projects yet.");
  const max = Math.max(0, ...all.map((p) => p.done + p.open));
  const row = (p) => {
    const seg = barSegments(p, max, BW);
    const bar = svg("svg", { class: "viz-svg bar-svg", viewBox: `0 0 ${BW} 14`, role: "img", "aria-label": `${p.name}: ${projectLine(p)}` },
      svg("rect", { class: "bar-done", x: 0, y: 0, width: seg.done, height: 14, rx: 3 }), svg("rect", { class: "bar-open", x: seg.done + (seg.done && seg.open ? 2 : 0), y: 0, width: seg.open, height: 14, rx: 3 }));
    return h("li", { class: "stack", "data-project": p.id }, h("span", {}, h("strong", { text: p.name }), " ", pill(String(p.status).toLowerCase())), p.done + p.open ? bar : null, h("span", { class: "muted", text: projectLine(p) }));
  };
  const group = (title, projects, extra) => h("div", { class: "stack" }, h("h3", { text: title }), extra ? h("p", { class: "muted", text: extra }) : null, projects.length ? h("ul", { class: "list" }, projects.map(row)) : empty("No projects under this goal yet."));
  return h("div", { class: "stack viz" }, map.goals.map((g) => group(g.title, g.projects, `${String(g.horizon).toLowerCase()} term`)), map.unassigned.length ? group("Not under a goal", map.unassigned) : null,
    h("p", { class: "legend" }, h("span", { class: "legend-item" }, svg("svg", { class: "swatch", viewBox: "0 0 14 14", width: 14, height: 14, "aria-hidden": "true" }, svg("rect", { class: "bar-done", x: 0, y: 0, width: 14, height: 14, rx: 3 })), " tasks done  "), h("span", { class: "legend-item" }, svg("svg", { class: "swatch", viewBox: "0 0 14 14", width: 14, height: 14, "aria-hidden": "true" }, svg("rect", { class: "bar-open", x: 0, y: 0, width: 14, height: 14, rx: 3 })), " tasks still open  "), "Bar length compares task counts between projects."));
}

export async function renderProgress(view) {
  const mine = ++token;
  mount(view, h("p", { class: "muted", text: "Loading…" }));
  const r = await api("GET", "/api/progress/overview");
  if (mine !== token || !state.active) return;
  const d = data(r);
  if (!d) return mount(view, h("h1", { text: "Progress" }), section("Progress", outcomeBox(lifeOutcome(r.status === 200 ? 403 : r.status, r.body))));
  mount(view, h("h1", { text: "Progress" }), h("p", { class: "muted", text: d.note }),
    section("Activity — the last 12 weeks", calendarView(d.calendar, d.levels)),
    section("Future Self over time", timelineView(d.timeline)),
    section("Goals and projects", mapView(d.map)),
    d.withheld?.length ? h("p", { class: "notice withheld", text: `🔒 Not shown (no access): ${d.withheld.join(", ")}.` }) : null);
}
