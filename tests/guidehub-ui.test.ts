import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { GRADES, buildBody, dateToInstant, formatDateOnly, isTerminal, lifeOutcome, linkablePeople, parseRoute, projectTransitions, questTransitions, statusLabel, taskCountsLine, taskTransitions, approvalOutcome, countdown, learningLine, listFrom, memoryLine, progressLabel, riskLabel, sectionNotices, writeOutcome } from "../guidehub/public/lib.js";

const PUB = path.resolve(import.meta.dirname, "../guidehub/public");
const read = (f: string) => readFileSync(path.join(PUB, f), "utf-8");

describe("cockpit rules (docs/guidehub/cockpit-design.md)", () => {
  it("§4: every write outcome maps to one honest state", () => {
    expect(writeOutcome(200, { status: "EXECUTED", message: "Task done" })).toMatchObject({ kind: "success", tone: "good", text: "Task done" });
    expect(writeOutcome(202, { status: "PENDING_APPROVAL", approvalId: "a1", message: "Needs OK" })).toMatchObject({ kind: "pending", tone: "warn", approvalId: "a1" });
    expect(writeOutcome(403, { status: "DENIED" })).toMatchObject({ kind: "denied", text: "You don't have permission to do that." });
    expect(writeOutcome(404, { status: "FAILED" })).toMatchObject({ kind: "notFound", text: "That item no longer exists." });
    expect(writeOutcome(422, { status: "FAILED", message: "That goal is closed." })).toMatchObject({ kind: "invalid", text: "That goal is closed." });
    expect(writeOutcome(400, null).kind).toBe("client");
    expect(writeOutcome(401, null).kind).toBe("auth");
    expect(writeOutcome(502, { error: "The API is down." })).toMatchObject({ kind: "unavailable", text: "The API is down." });
    expect(writeOutcome(500, null).kind).toBe("error");
  });

  it("a 200 that is not EXECUTED (or a 202 that is not PENDING) is never shown as success", () => {
    expect(writeOutcome(200, { status: "FAILED", message: "x" }).kind).not.toBe("success");
    expect(writeOutcome(200, null).kind).not.toBe("success");
    expect(writeOutcome(202, { status: "EXECUTED" }).kind).not.toBe("pending");
  });

  it("approvals resolve only from the response: 'done' needs executed:true; a failed execution is not success", () => {
    expect(approvalOutcome(200, { executed: true }, "approve")).toMatchObject({ tone: "good", done: true, text: "Approved and done." });
    expect(approvalOutcome(200, { executed: false, execution: { status: "FAILED" } }, "approve")).toMatchObject({ tone: "bad", done: true, text: "Approved, but it failed. Nothing was changed." });
    expect(approvalOutcome(200, {}, "approve").text).toBe("Approved, but it failed. Nothing was changed.");
    expect(approvalOutcome(200, { executed: false }, "deny").text).toBe("Denied. Nothing was changed.");
    expect(approvalOutcome(409, null, "approve")).toMatchObject({ done: true, text: "Already decided." });
    expect(approvalOutcome(410, null, "approve").text).toBe("This request expired.");
    expect(approvalOutcome(403, null, "approve")).toMatchObject({ done: false, text: "This interface can't approve this action." });
    expect(approvalOutcome(404, null, "approve").done).toBe(true);
    expect(approvalOutcome(500, null, "approve")).toMatchObject({ done: false });
  });

  it("§1.2: null progress reads 'No evidence yet' — never 0%, never a bar; reaching the target leaves the decision to the owner", () => {
    expect(progressLabel(null)).toBe("No evidence yet");
    expect(progressLabel(undefined)).toBe("No evidence yet");
    expect(progressLabel(0)).toBe("0% by recorded readings"); // a real reading at the baseline is not "no evidence"
    expect(progressLabel(0.5)).toBe("50% by recorded readings");
    expect(progressLabel(0.256)).toBe("26% by recorded readings");
    expect(progressLabel(1)).toMatch(/you decide when it's achieved/);
    expect(progressLabel(7)).toMatch(/you decide/);
    expect(progressLabel(-3)).toBe("0% by recorded readings");
  });

  it("withheld and unavailable sections are named notices, never a silent empty state", () => {
    const n = sectionNotices({ withheld: ["memories", "life"], unavailable: ["knowledge"] });
    expect(n).toEqual([
      { section: "memories", kind: "withheld", text: "Memories: not available to Jarvis (no permission)." },
      { section: "life", kind: "withheld", text: "Goals and projects: not available to Jarvis (no permission)." },
      { section: "knowledge", kind: "unavailable", text: "Knowledge: couldn't be read right now." },
    ]);
    expect(sectionNotices({ withheld: [], unavailable: [] })).toEqual([]);
    expect(sectionNotices(undefined)).toEqual([]);
    expect(sectionNotices({ withheld: ["something-new"] })[0].text).toContain("something-new");
  });

  it("a guess is never shown as a fact: inferences are labelled unless confirmed", () => {
    expect(memoryLine({ type: "INFERENCE", confirmed: false, content: "likes tea" })).toEqual({ label: "Jarvis thinks (unconfirmed)", text: "likes tea", guess: true });
    expect(memoryLine({ type: "INFERENCE", confirmed: true, content: "likes tea" })).toMatchObject({ label: "Inference (confirmed)", guess: false });
    expect(memoryLine({ type: "FACT", content: "born in 1990" })).toEqual({ label: "fact", text: "born in 1990", guess: false });
  });

  it("learning is labelled self-reported and has no score, streak or level", () => {
    const line = learningLine({ title: "Spanish", minutesLast7Days: 90, cards: 12, due: 3 });
    expect(line).toBe("Spanish — 90 min in the last 7 days (self-reported), 3 of 12 cards due");
    expect(line).not.toMatch(/streak|level|xp|score|points/i);
    expect(GRADES.map((g) => g.value)).toEqual([0, 1, 2, 3]);
  });

  it("lists arrive as a bare array (approvals) or a Result {data} (decisions, learning); a failure is never an empty list", () => {
    expect(listFrom(200, [1, 2])).toEqual([1, 2]);
    expect(listFrom(200, { status: "EXECUTED", data: [{ id: "d" }] })).toEqual([{ id: "d" }]);
    expect(listFrom(200, { status: "EXECUTED", data: [] })).toEqual([]);
    for (const [s, b] of [[403, { status: "DENIED" }], [502, { error: "x" }], [200, { status: "DENIED", message: "no" }], [200, { status: "EXECUTED", data: { not: "a list" } }], [200, null], [401, []]] as const) expect(listFrom(s, b), `${s} ${JSON.stringify(b)}`).toBeNull();
  });

  it("countdown is derived from the server's expiry, and risk has plain names", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(countdown("2026-01-01T00:12:10Z", now)).toBe("in 13 min");
    expect(countdown("2026-01-01T02:05:00Z", now)).toBe("in 2 h 5 min");
    expect(countdown("2025-12-31T23:59:00Z", now)).toBe("expired");
    expect(countdown("not a date", now)).toBe("");
    expect([riskLabel("LOW"), riskLabel("SENSITIVE"), riskLabel("DANGEROUS")]).toEqual(["Routine", "Sensitive", "Dangerous"]);
  });
});

describe("Life rules (step 2)", () => {
  it("offers exactly the transitions the API allows — and none from a terminal state", () => {
    expect(projectTransitions("ACTIVE").map((t) => t.to)).toEqual(["PAUSED", "COMPLETED", "ARCHIVED"]);
    expect(projectTransitions("PAUSED").map((t) => t.to)).toEqual(["ACTIVE", "COMPLETED", "ARCHIVED"]);
    expect(projectTransitions("COMPLETED").map((t) => t.to)).toEqual(["ACTIVE", "ARCHIVED"]);
    expect(projectTransitions("ARCHIVED")).toEqual([]);
    expect(questTransitions("PLANNED").map((t) => t.action)).toEqual(["QUEST_START", "QUEST_ABANDON"]);
    expect(questTransitions("ACTIVE").map((t) => t.action)).toEqual(["QUEST_COMPLETE", "QUEST_ABANDON"]);
    expect(questTransitions("PLANNED").some((t) => t.action === "QUEST_COMPLETE")).toBe(false); // a quest must be started before it can be completed
    expect(questTransitions("COMPLETED")).toEqual([]);
    expect(questTransitions("ABANDONED")).toEqual([]);
    expect(taskTransitions("TODO").map((t) => t.action)).toEqual(["TASK_COMPLETE", "TASK_CANCEL"]);
    expect(taskTransitions("IN_PROGRESS")).toHaveLength(2);
    expect(taskTransitions("DONE")).toEqual([]);
    expect(taskTransitions("CANCELLED")).toEqual([]);
    for (const [k, st] of [["goal", "ACHIEVED"], ["goal", "ABANDONED"], ["quest", "COMPLETED"], ["quest", "ABANDONED"], ["task", "DONE"], ["task", "CANCELLED"], ["project", "ARCHIVED"], ["vision", "ARCHIVED"]] as const) expect(isTerminal(k, st), `${k} ${st}`).toBe(true);
    for (const [k, st] of [["goal", "ACTIVE"], ["quest", "PLANNED"], ["quest", "ACTIVE"], ["task", "TODO"], ["project", "COMPLETED"], ["project", "PAUSED"], ["vision", "ACTIVE"]] as const) expect(isTerminal(k, st), `${k} ${st}`).toBe(false);
  });

  it("abandoning needs a reason; completing a quest asks for an optional note", () => {
    expect(questTransitions("ACTIVE").find((t) => t.action === "QUEST_ABANDON")!.ask).toBe("reason");
    expect(questTransitions("ACTIVE").find((t) => t.action === "QUEST_COMPLETE")!.ask).toBe("note");
    expect(questTransitions("PLANNED").find((t) => t.action === "QUEST_START")!.ask).toBeUndefined();
  });

  it("dates: a calendar date becomes a noon-UTC instant (same date everywhere); impossible dates are rejected", () => {
    expect(dateToInstant("2027-03-05")).toBe("2027-03-05T12:00:00.000Z");
    for (const bad of ["", "2027-02-30", "2027-13-01", "05/03/2027", "2027-3-5", "tomorrow", null, undefined, 5]) expect(dateToInstant(bad as never), String(bad)).toBeNull();
    expect(formatDateOnly("2027-03-05T12:00:00.000Z")).toMatch(/2027/);
  });

  it("form values become an action body: trimmed, empties ABSENT, dates converted — and nothing is invented", () => {
    expect(buildBody({ title: "  Ship it  ", description: "", horizon: "LONG", targetDate: "2027-03-05", visionId: undefined, extra: null }, ["targetDate"]))
      .toEqual({ body: { title: "Ship it", horizon: "LONG", targetDate: "2027-03-05T12:00:00.000Z" }, invalid: [] });
    expect(buildBody({ title: "x", targetDate: "2027-02-31" }, ["targetDate"])).toEqual({ body: { title: "x" }, invalid: ["targetDate"] });
    const b = buildBody({ name: "Ana" }).body;
    expect(Object.keys(b)).toEqual(["name"]); // no principal, no status, no id
    expect(buildBody({}).body).toEqual({});
  });

  it("a 202 from a Life write says nothing has changed yet; other outcomes are the standard ones", () => {
    expect(lifeOutcome(202, { status: "PENDING_APPROVAL", approvalId: "a", message: "Approval needed: Delete person" })).toMatchObject({ kind: "pending", text: "Sent for your approval — nothing has changed yet.", approvalId: "a" });
    expect(lifeOutcome(200, { status: "EXECUTED", message: "Goal created: x" })).toMatchObject({ kind: "success", text: "Goal created: x" });
    expect(lifeOutcome(404, null).kind).toBe("notFound");
    expect(lifeOutcome(422, { status: "FAILED", message: "That goal is achieved and can't be changed." }).text).toMatch(/can't be changed/);
  });

  it("the link picker never offers someone already linked", () => {
    const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(linkablePeople(all, [{ personId: "b" }]).map((p) => p.id)).toEqual(["a", "c"]);
    expect(linkablePeople(all, [{ person: { id: "a" } }, { personId: "c" }]).map((p) => p.id)).toEqual(["b"]);
    expect(linkablePeople(all, undefined)).toHaveLength(3);
    expect(linkablePeople(undefined, [])).toEqual([]);
  });

  it("routes: only known views and valid project ids; anything else is Today", () => {
    const id = "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e";
    expect(parseRoute("")).toEqual({ view: "today" });
    expect(parseRoute("#/today")).toEqual({ view: "today" });
    expect(parseRoute("#/life")).toEqual({ view: "life" });
    expect(parseRoute(`#/life/projects/${id}`)).toEqual({ view: "project", id });
    for (const bad of ["#/life/projects/nope", "#/life/projects/", "#/admin", "#/life/projects/" + id + "/x", "#//etc", "#/life/projects/" + id.toUpperCase()]) expect(parseRoute(bad), bad).toEqual({ view: "today" });
  });

  it("labels are plain words; counts never hide cancelled work", () => {
    expect(statusLabel("IN_PROGRESS")).toBe("in progress");
    expect(taskCountsLine({ open: 3, done: 2, cancelled: 0 })).toBe("3 open · 2 done");
    expect(taskCountsLine({ open: 0, done: 1, cancelled: 4 })).toBe("0 open · 1 done · 4 cancelled");
    expect(taskCountsLine(undefined)).toBe("0 open · 0 done");
  });
});

describe("frontend safety (static checks)", () => {
  const FILES = ["app.js", "ui.js", "life.js", "lib.js"];
  const all = FILES.map((f) => [f, read(f)] as const);
  const joined = all.map(([, src]) => src).join("\n");
  it("nothing from the API is ever parsed as HTML or executed", () => {
    for (const [f, src] of all) expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|srcdoc|dangerouslySet/);
  });
  it("the page has no inline script, no inline handler and no inline style (so the CSP can forbid them)", () => {
    const html = read("index.html");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/https?:\/\//i); // no third-party origins at all
    expect(read("styles.css")).not.toMatch(/@import|url\(\s*["']?https?:/i);
    for (const [f, src] of all) expect(src, f).not.toMatch(/\.style\.|setAttribute\(\s*["']style/); // styling is classes only
  });
  it("the UI never handles a principal id, a bearer token, or storage of secrets", () => {
    for (const [f, src] of all) expect(src, f).not.toMatch(/principalId|Authorization|Bearer|aos_|localStorage|sessionStorage|document\.cookie/);
  });
  it("children are swapped in only through mount(), which drops null/false sections (a raw replaceChildren prints the word 'null')", () => {
    expect(joined.match(/replaceChildren\((?!\))/g)).toHaveLength(1); // the single call inside mount()
    expect(read("ui.js")).toMatch(/export const mount = \(box, \.\.\.nodes\) => box\.replaceChildren\(\.\.\.nodes\.flat\(\)\.filter\(/);
  });
  it("every call goes through the one api() wrapper (in ui.js) that adds the CSRF header", () => {
    expect(joined.match(/fetch\(/g)).toHaveLength(1);
    expect(read("ui.js")).toMatch(/headers: \{ \.\.\.CSRF/);
  });
  it("it only ever calls routes the cockpit proxy allows (GET/POST paths, action names, and the transitions it offers)", async () => {
    const { matchRule } = await import("../guidehub/proxy.js");
    const UUID = "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e";
    const called = [...joined.matchAll(/api\(\s*"(GET|POST|DELETE)"\s*,\s*([`"])([^`"]+)\2/g)].map((m) => [m[1], m[3]] as const);
    expect(called.length).toBeGreaterThan(12);
    for (const [method, raw] of called) {
      const p = raw.split("?")[0];
      if (p === "/session") continue; // the BFF's own route
      if (raw.includes("${skill}/${name}")) continue; // the generic act() wrapper: every call site is checked below by its ("system.x", "NAME") pair
      const concrete = p.replace("${decision}", "approve").replace(/\$\{[^}]+\}/g, UUID);
      expect(matchRule(method, concrete), `${method} ${raw}`).toBeDefined();
    }
    // action names appear as ("system.x", "NAME") pairs at every call site
    const actions = [...joined.matchAll(/"(system\.[a-z]+)",\s*"([A-Z_]+)"/g)].map((m) => [m[1], m[2]] as const);
    expect(actions.length).toBeGreaterThanOrEqual(16);
    for (const [skill, name] of actions) expect(matchRule("POST", `/api/actions/${skill}/${name}`), `${skill} ${name}`).toBeDefined();
    // and the action names that come from the transition tables
    for (const st of ["PLANNED", "ACTIVE"]) for (const t of questTransitions(st)) expect(matchRule("POST", `/api/actions/system.life/${t.action}`), t.action).toBeDefined();
    for (const t of taskTransitions("TODO")) expect(matchRule("POST", `/api/actions/system.tasks/${t.action}`), t.action).toBeDefined();
    expect(matchRule("POST", "/api/actions/system.life/PROJECT_SET_STATUS")).toBeDefined();
  });
  it("closed items never get an edit or reopen control: the only writers offered for a terminal state come from the transition tables, which are empty for them", () => {
    for (const [kind, st, fn] of [["quest", "COMPLETED", questTransitions], ["quest", "ABANDONED", questTransitions], ["task", "DONE", taskTransitions], ["task", "CANCELLED", taskTransitions], ["project", "ARCHIVED", projectTransitions]] as const) {
      expect(isTerminal(kind, st)).toBe(true);
      expect((fn as (s: string) => unknown[])(st), `${kind} ${st}`).toEqual([]);
    }
    expect(read("life.js")).not.toMatch(/GOAL_REOPEN|QUEST_REOPEN|TASK_REOPEN|VISION_REOPEN/);
  });
  it("the shipped public directory contains only the expected static files", () => {
    expect(readdirSync(PUB).sort()).toEqual(["app.js", "index.html", "lib.d.ts", "lib.js", "life.js", "styles.css", "ui.js"]);
  });
});
