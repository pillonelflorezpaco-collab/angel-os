import { LOOP_GROUPS, badgeProgress, formatWhen, lifeOutcome, loopHref, streakLine } from "./lib.js";
import { api, empty, h, mount, outcomeBox, section, state } from "./ui.js";
import { pill } from "./kit.js";

// Today: what is actually open (assembled by the server from existing records — nothing scored or invented) and factual badges
// (thresholds on real counts). This module only displays what the server says.

const data = (r) => (r.status === 200 && r.body?.status === "EXECUTED" ? r.body.data : null);

export async function renderLoops(box) {
  const r = await api("GET", "/api/today/loops");
  if (!state.active) return;
  const d = data(r);
  if (!d) return mount(box, section("What matters", outcomeBox(lifeOutcome(r.status === 200 ? 403 : r.status, r.body))));
  const done = async (id, btn) => {
    btn.disabled = true;
    const res = await api("POST", "/api/actions/system.tasks/TASK_COMPLETE", { taskId: id });
    if (res.status === 200 || res.status === 404) return renderLoops(box);
    btn.disabled = false;
    btn.after(h("span", { class: "outcome bad inline", role: "alert", text: ` ${lifeOutcome(res.status, res.body).text}` }));
  };
  const item = (l) => {
    const href = loopHref(l.ref);
    return h("li", { class: "stack", "data-loop": l.kind },
      h("span", {}, href ? h("a", { href, class: "strong", text: l.title }) : h("strong", { text: l.title }), l.kind === "TASK" && l.ref ? " " : null,
        l.kind === "TASK" && l.ref ? h("button", { class: "small", "aria-label": `Mark done: ${l.title}`, text: "Done", onclick: (e) => done(l.ref.id, e.target) }) : null),
      h("span", { class: "muted", text: `${l.why}${l.when ? ` · ${formatWhen(l.when, state.timeZone)}` : ""}` }));
  };
  const groups = LOOP_GROUPS.map((g) => (d[g.key]?.length ? h("div", { class: "stack" }, h("h3", { text: g.label }), h("ul", { class: "list" }, d[g.key].map(item))) : null));
  const any = LOOP_GROUPS.some((g) => d[g.key]?.length);
  mount(box, section("What matters", h("p", { class: "muted", text: d.note }), any ? groups : empty("Nothing open is waiting on you right now."),
    d.withheld?.length ? h("p", { class: "notice withheld", text: `🔒 Not shown (no access): ${d.withheld.join(", ")}.` }) : null));
}

export async function renderBadges(box) {
  const r = await api("GET", "/api/progress/badges");
  if (!state.active) return;
  const d = data(r);
  if (!d) return mount(box, section("On record", outcomeBox(lifeOutcome(r.status === 200 ? 403 : r.status, r.body))));
  const earned = d.badges.filter((b) => b.earned);
  const next = d.badges.filter((b) => !b.earned);
  const row = (b) => h("li", { class: "stack", "data-badge": b.key, "data-earned": String(b.earned) },
    h("span", {}, pill(badgeProgress(b)), " ", h("strong", { text: b.title })), h("span", { class: "muted", text: `Rule: ${b.statement}` }));
  mount(box, section("On record", h("p", { text: streakLine(d.streak) }),
    earned.length ? h("ul", { class: "list" }, earned.map(row)) : empty("No badges earned yet — each one is a count of things you actually recorded."),
    next.length ? h("details", {}, h("summary", { text: `Not earned yet (${next.length})` }), h("ul", { class: "list" }, next.map(row))) : null,
    h("p", { class: "muted", text: d.note })));
}
