import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { GRADES, buildResultBody, withSuperseded, buildDecisionBody, canReview, canSupersede, decisionStatus, evidenceTag, pickerRow, resultLine, LIMITS, buildBody, dateToInstant, formatDateOnly, isTerminal, lifeOutcome, linkablePeople, parseRoute, projectTransitions, questTransitions, statusLabel, taskCountsLine, taskTransitions, approvalOutcome, countdown, learningLine, listFrom, memoryLine, progressLabel, riskLabel, sectionNotices, writeOutcome, hypothesisLabel, HYPOTHESIS_ORDER, isClosedExperiment, evidenceKindLabel, evidenceText, evidenceGroups, stateHeading, metricReadingLine, buildStateBody } from "../guidehub/public/lib.js";

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

  it("§1.2: null progress reads 'No measured readings yet' — never 0%, never a bar; reaching the target leaves the decision to the owner", () => {
    expect(progressLabel(null)).toBe("No measured readings yet");
    expect(progressLabel(undefined)).toBe("No measured readings yet");
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

describe("Decision rules (step 3)", () => {
  const NOW = Date.parse("2026-06-01T00:00:00Z");
  it("status: superseded beats reviewed beats due beats waiting; a list row can never claim 'superseded'", () => {
    expect(decisionStatus({ supersededBy: { id: "x" }, reviewedAt: "2026-01-01" }, NOW).kind).toBe("superseded");
    expect(decisionStatus({ reviewedAt: "2026-01-01T00:00:00Z", reviewAt: "2020-01-01" }, NOW).kind).toBe("reviewed");
    expect(decisionStatus({ reviewAt: "2026-05-31T00:00:00Z" }, NOW)).toEqual({ kind: "due", label: "Time to look back" });
    expect(decisionStatus({ reviewAt: "2026-06-01T00:00:00Z" }, NOW).kind).toBe("due"); // exactly now counts as due
    expect(decisionStatus({ reviewAt: "2026-09-15T12:00:00Z" }, NOW)).toMatchObject({ kind: "waiting" });
    expect(decisionStatus({ reviewAt: "2026-09-15T12:00:00Z" }, NOW).label).toMatch(/2026/);
    expect(decisionStatus({}, NOW)).toEqual({ kind: "recorded", label: "Recorded" });
    expect(decisionStatus({ supersededBy: null, reviewedAt: null, reviewAt: null }, NOW).kind).toBe("recorded");
  });

  it("a decision can be superseded once and reviewed once — never edited", () => {
    expect(canSupersede({})).toBe(true);
    expect(canSupersede({ supersededBy: { id: "n" } })).toBe(false);
    expect(canReview({})).toBe(true);
    expect(canReview({ reviewedAt: "2026-01-01" })).toBe(false);
  });

  it("the record form becomes a DECISION_RECORD body, trimmed, empties absent, dates converted, nothing invented", () => {
    const r = buildDecisionBody({ title: "  Adopt a cockpit ", decision: "Build it", question: "", reasoning: "It saves time", expected: "faster reviews", reviewAt: "2026-09-01" });
    expect(r.errors).toEqual([]);
    expect(r.body).toEqual({ title: "Adopt a cockpit", decision: "Build it", reasoning: "It saves time", expected: "faster reviews", reviewAt: "2026-09-01T12:00:00.000Z" });
    expect(Object.keys(r.body)).not.toEqual(expect.arrayContaining(["principalId", "status", "outcome", "reviewedAt"]));
  });

  it("required words and impossible dates are reported before anything is sent", () => {
    expect(buildDecisionBody({}).errors).toEqual(["A title is needed.", "What did you decide?"]);
    expect(buildDecisionBody({ title: "t", decision: "d", reviewAt: "2026-02-31" }).errors).toEqual(["reviewAt isn't a valid date"]);
  });

  it("options: 2–6 or none; the chosen one is re-mapped past blank rows; choosing needs options", () => {
    const opts = [{ label: "Keep" }, { label: "  " }, { label: "Stop", pros: "sleep", cons: "headaches" }];
    const r = buildDecisionBody({ title: "t", decision: "d" }, opts, 2);
    expect(r.errors).toEqual([]);
    expect(r.body.options).toEqual([{ label: "Keep" }, { label: "Stop", pros: "sleep", cons: "headaches" }]);
    expect(r.body.chosenIndex).toBe(1); // row 2 in the form was blank, so "Stop" is option index 1
    expect(buildDecisionBody({ title: "t", decision: "d" }, [{ label: "Only one" }], 0).errors).toEqual(["Give at least 2 options, or none."]);
    expect(buildDecisionBody({ title: "t", decision: "d" }, Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` }))).errors).toEqual(["At most 6 options."]);
    expect(buildDecisionBody({ title: "t", decision: "d" }, [{ label: "a" }, { label: "b" }], 5).errors).toEqual(["The chosen option must have a label."]);
    expect(buildDecisionBody({ title: "t", decision: "d" }, [{ label: "a" }, { label: " " }], 1).errors).toEqual(["Give at least 2 options, or none.", "The chosen option must have a label."]);
    expect(buildDecisionBody({ title: "t", decision: "d" }, [], 0).errors).toEqual(["Choose among options you have listed."]);
    expect(buildDecisionBody({ title: "t", decision: "d" }, [{ label: "a" }, { label: "b" }]).body).not.toHaveProperty("chosenIndex");
    expect(buildDecisionBody({ title: "t", decision: "d" }, [], null).body).not.toHaveProperty("options");
    expect(LIMITS.options).toEqual({ min: 2, max: 6 });
  });

  it("evidence: notes carry text, references carry only an id (the server writes the label); blanks are dropped; capped at 10", () => {
    const r = buildDecisionBody({ title: "t", decision: "d" }, [], null, [
      { kind: "NOTE", note: "  read an article " }, { kind: "NOTE", note: "  " }, { kind: "MEMORY", refId: "m1", note: "ignored" }, { kind: "TASK", refId: "t1" }, { kind: "KNOWLEDGE" },
    ]);
    expect(r.body.evidence).toEqual([{ kind: "NOTE", note: "read an article" }, { kind: "MEMORY", refId: "m1" }, { kind: "TASK", refId: "t1" }]);
    expect(JSON.stringify(r.body.evidence)).not.toContain("label"); // a client-supplied label would be refused by the API
    const many = Array.from({ length: 11 }, (_, i) => ({ kind: "TASK", refId: `t${i}` }));
    expect(buildDecisionBody({ title: "t", decision: "d" }, [], null, many).errors).toEqual(["At most 10 pieces of evidence."]);
  });

  it("changing your mind records a NEW decision that names the old one", () => {
    expect(buildDecisionBody({ title: "t", decision: "d" }, [], null, [], "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e").body.supersedesId).toBe("0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e");
    expect(buildDecisionBody({ title: "t", decision: "d" }).body).not.toHaveProperty("supersedesId");
  });

  it("evidence tags say what a reference is; results show a measurement only with both value and unit; picker rows are plain text", () => {
    expect([evidenceTag("MEMORY"), evidenceTag("KNOWLEDGE"), evidenceTag("TASK"), evidenceTag("NOTE")]).toEqual(["memory", "knowledge", "task", "note"]);
    expect(resultLine({ statement: "Reviews were faster", value: 12.5, unit: "min" })).toBe("Reviews were faster — 12.5 min");
    expect(resultLine({ statement: "It worked", value: 0, unit: "errors" })).toBe("It worked — 0 errors"); // zero is a real measurement
    expect(resultLine({ statement: "It worked", value: 5, unit: null })).toBe("It worked");
    expect(resultLine({ statement: "It worked" })).toBe("It worked");
    expect(pickerRow("MEMORY", { id: "m", type: "INFERENCE", confirmed: false, content: "likes tea" })).toEqual({ refId: "m", title: "likes tea", sub: "Jarvis thinks (unconfirmed)" });
    expect(pickerRow("KNOWLEDGE", { id: "k", title: "Spaced repetition", kind: "METHOD" })).toEqual({ refId: "k", title: "Spaced repetition", sub: "method" });
    expect(pickerRow("TASK", { id: "t", title: "Try decaf", status: "IN_PROGRESS" })).toEqual({ refId: "t", title: "Try decaf", sub: "in progress" });
  });

  it("a replaced decision is marked replaced (the newer one names it), so it is never offered as 'time to look back'", () => {
    const list = [{ id: "new", supersedesId: "old", reviewAt: "2020-01-01" }, { id: "old", reviewAt: "2020-01-01" }, { id: "alone", reviewAt: "2020-01-01" }];
    const marked = withSuperseded(list);
    expect(marked.find((d) => d.id === "old")!.supersededBy).toEqual({ id: "new" });
    expect(marked.find((d) => d.id === "new")!.supersededBy).toBeNull();
    expect(decisionStatus(marked.find((d) => d.id === "old"), NOW).kind).toBe("superseded");
    expect(decisionStatus(marked.find((d) => d.id === "alone"), NOW).kind).toBe("due");
    expect(withSuperseded(undefined)).toEqual([]);
  });

  it("results about a decision: a statement, and a measurement only as value AND unit; zero is a real value", () => {
    expect(buildResultBody({ statement: "  Reviews got faster ", value: "12.5", unit: " min " }, "d1")).toEqual({ body: { subjectKind: "DECISION", subjectId: "d1", statement: "Reviews got faster", value: 12.5, unit: "min" }, errors: [] });
    expect(buildResultBody({ statement: "None broke", value: "0", unit: "errors" }, "d1").body.value).toBe(0);
    expect(buildResultBody({ statement: "It worked", value: "", unit: "" }, "d1")).toEqual({ body: { subjectKind: "DECISION", subjectId: "d1", statement: "It worked" }, errors: [] });
    expect(buildResultBody({ statement: "x", value: "5", unit: "" }, "d1").errors).toEqual(["A measurement needs both a value and a unit."]);
    expect(buildResultBody({ statement: "x", value: "", unit: "km" }, "d1").errors).toEqual(["A measurement needs both a value and a unit."]);
    expect(buildResultBody({ statement: "x", value: "abc", unit: "km" }, "d1").errors).toEqual(["The value must be a number."]);
    expect(buildResultBody({ statement: "x", value: "Infinity", unit: "km" }, "d1").errors).toEqual(["The value must be a number."]);
    expect(buildResultBody({ statement: " ", value: "", unit: "" }, "d1").errors).toEqual(["Say what happened."]);
  });

  it("routes: #/decisions and #/decisions/<uuid> only", () => {
    const id = "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e";
    expect(parseRoute("#/decisions")).toEqual({ view: "decisions" });
    expect(parseRoute(`#/decisions/${id}`)).toEqual({ view: "decision", id });
    for (const bad of ["#/decisions/", "#/decisions/nope", `#/decisions/${id}/x`, `#/decisions/${id.toUpperCase()}`, "#/decision"]) expect(parseRoute(bad), bad).toEqual({ view: "today" });
  });
});

describe("frontend safety (static checks)", () => {
  const FILES = ["app.js", "ui.js", "kit.js", "life.js", "decisions.js", "growth.js", "lib.js"];
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
  it("EVERY '/api/…' string in the UI (even ones assigned to variables) is a route the proxy allows", async () => {
    const { matchRule } = await import("../guidehub/proxy.js");
    const UUID = "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e";
    const literals = [...joined.matchAll(/[`"](\/api\/[^`"]*)[`"]/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(20);
    for (const raw of literals) {
      if (raw.includes("${skill}/${name}")) continue; // generic act(): each call site is checked by its pair
      const p = raw.split("?")[0].replace("${decision}", "approve").replace(/\$\{[^}]+\}/g, UUID);
      expect(["GET", "POST"].some((m) => matchRule(m, p)), raw).toBe(true);
    }
    for (const needed of ["/api/memory/search", "/api/knowledge/search", "/api/tasks", "/api/results", "/api/decisions"]) expect(literals.some((l) => l.startsWith(needed)), needed).toBe(true);
  });

  it("closed items never get an edit or reopen control: the only writers offered for a terminal state come from the transition tables, which are empty for them", () => {
    for (const [kind, st, fn] of [["quest", "COMPLETED", questTransitions], ["quest", "ABANDONED", questTransitions], ["task", "DONE", taskTransitions], ["task", "CANCELLED", taskTransitions], ["project", "ARCHIVED", projectTransitions]] as const) {
      expect(isTerminal(kind, st)).toBe(true);
      expect((fn as (s: string) => unknown[])(st), `${kind} ${st}`).toEqual([]);
    }
    expect(read("life.js")).not.toMatch(/GOAL_REOPEN|QUEST_REOPEN|TASK_REOPEN|VISION_REOPEN/);
    // decisions are history: no update/edit/delete of a decision exists anywhere in the UI
    expect(read("decisions.js")).not.toMatch(/DECISION_UPDATE|DECISION_EDIT|DECISION_DELETE|DECISION_REOPEN/);
    expect(joined).not.toMatch(/"system\.decisions",\s*"(?!DECISION_RECORD|DECISION_REVIEW)/);
  });
  it("the shipped public directory contains only the expected static files", () => {
    expect(readdirSync(PUB).sort()).toEqual(["app.js", "decisions.js", "growth.js", "index.html", "kit.js", "lib.d.ts", "lib.js", "life.js", "styles.css", "ui.js"]);
  });
});


describe("Step 5: Future Self + Learning screens", () => {
  const growth = read("growth.js");
  const UUID = "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e";

  it("routes: #/future-self and #/learning exactly; nothing else is a new view", () => {
    expect(parseRoute("#/future-self")).toEqual({ view: "future" });
    expect(parseRoute("#/learning")).toEqual({ view: "learning" });
    for (const bad of ["#/future-self/", "#/future", "#/learning/x", `#/learning/${UUID}`, "#/Learning"]) expect(parseRoute(bad), bad).toEqual({ view: "today" });
  });

  it("every action the screens send is allowed by the proxy, and the exact read routes exist (default-deny elsewhere)", async () => {
    const { matchRule } = await import("../guidehub/proxy.js");
    const skills: Record<string, string> = { FUTURE: "system.future", LEARNING: "system.learning" };
    const pairs = [...growth.matchAll(/\b(FUTURE|LEARNING),\s*"([A-Z_]+)"/g)].map((m) => [skills[m[1]], m[2]] as const);
    expect(pairs.length).toBeGreaterThanOrEqual(8);
    for (const [skill, name] of pairs) expect(matchRule("POST", `/api/actions/${skill}/${name}`), `${skill} ${name}`).toBeDefined();
    for (const p of ["/api/future/aspirations", `/api/future/aspirations/${UUID}/states`, "/api/learning/topics", "/api/learning/sessions", "/api/learning/objectives", "/api/learning/experiments", `/api/learning/experiments/${UUID}`]) expect(matchRule("GET", p), p).toBeDefined();
    // not reachable: the aspiration detail, closing/releasing aspirations, session/card/topic writes, anything wildcarded
    for (const [m, p] of [["GET", `/api/future/aspirations/${UUID}`], ["GET", "/api/future/aspirations/x/states"], ["GET", "/api/learning/cards/x"], ["GET", "/api/learning/experiments/x"], ["GET", `/api/learning/experiments/${UUID}/x`], ["POST", "/api/actions/system.future/ASPIRATION_ACHIEVE"], ["POST", "/api/actions/system.future/ASPIRATION_UPDATE"], ["POST", "/api/actions/system.future/METRIC_CREATE"], ["POST", "/api/actions/system.learning/SESSION_LOG"], ["POST", "/api/actions/system.learning/CARD_REVIEW/x"], ["POST", "/api/learning/experiments"], ["GET", "/api/learning"], ["GET", "/api/future"]] as const)
      expect(matchRule(m, p), `${m} ${p}`).toBeUndefined();
  });

  it("no score, level, XP, percentage or streak vocabulary appears in the new screens", () => {
    expect(growth).not.toMatch(/\bxp\b|level|streak|score|badge|rank|\bprogress\b|Math\.round|%/i);
    expect(growth).not.toMatch(/progressLabel/);
  });

  it("evidence is shown with the SERVER's label; the UI sends ids and stances, never labels or principals", () => {
    const body = buildStateBody(UUID, { current: "c", gap: "", desired: "d", note: "" }, [{ sourceKind: "RESULT", sourceId: UUID, stance: "SUPPORTS", shown: "MY OWN LABEL", sub: "x" } as any]);
    expect(body.errors).toEqual([]);
    expect(body.body).toEqual({ aspirationId: UUID, current: "c", desired: "d", evidence: [{ sourceKind: "RESULT", sourceId: UUID, stance: "SUPPORTS" }] });
    expect(JSON.stringify(body.body)).not.toContain("MY OWN LABEL");
    expect(buildStateBody(UUID, { current: "c", desired: "d" }, []).errors).toContain("Add at least one piece of evidence.");
    expect(buildStateBody(UUID, { current: "", desired: "" }, []).errors).toHaveLength(3);
  });

  it("lived evidence is distinguished from facts and inferences; no evidence is stated, never implied as contradiction", () => {
    expect(evidenceKindLabel({ sourceKind: "MEMORY", memoryType: "EXPERIENCE" })).toBe("Lived experience");
    expect(evidenceKindLabel({ sourceKind: "MEMORY", memoryType: "LESSON" })).toBe("Lesson");
    for (const t of ["FACT", "INFERENCE", "PREFERENCE"]) expect(evidenceKindLabel({ sourceKind: "MEMORY", memoryType: t })).toMatch(/not lived evidence/);
    expect(evidenceText({ label: "ran 5k" })).toBe("ran 5k");
    expect(evidenceText({ label: null })).toBe("This source is no longer available.");
    expect(evidenceText({ retracted: true, label: "x" })).toMatch(/retracted/);
    expect(evidenceGroups([]).every((g) => g.items.length === 0)).toBe(true);
    expect(evidenceGroups([{ stance: "CONTRADICTS" }, { stance: "SUPPORTS" }, { stance: "SUPPORTS" }]).map((g) => g.items.length)).toEqual([2, 1, 0]);
    expect(growth.match(/No evidence is recorded\./g)?.length).toBeGreaterThanOrEqual(2); // objectives and the evidence list both say it
    expect(growth).toContain('h("p", { class: "muted", text: "No evidence is recorded." })');
    expect(growth).not.toMatch(/no contradict|not contradict|uncontradict/i); // silence is never a finding
  });

  it("history reads as history; readings are stated, not graded; hypothesis states are words", () => {
    const s = (basis: string) => ({ basis, createdAt: "2026-03-01T00:00:00.000Z" });
    expect(stateHeading(s("INITIAL"), 0, 2)).toBe("Starting state recorded on Mar 1, 2026 — earlier");
    expect(stateHeading(s("EVIDENCED"), 1, 2)).toMatch(/Updated state recorded on .* — latest$/);
    expect(metricReadingLine({ latest: null, unit: "km" })).toBe("No readings recorded yet.");
    expect(metricReadingLine({ latest: 0, unit: "km", lastObservedAt: "2026-03-01T00:00:00.000Z" })).toMatch(/^Latest recorded reading: 0 km on/); // zero is a reading
    expect(HYPOTHESIS_ORDER.map(hypothesisLabel).every((t) => !/\d/.test(t))).toBe(true);
    expect(isClosedExperiment("CONFIRMED") && isClosedExperiment("REJECTED")).toBe(true);
    for (const open of ["CANDIDATE", "OBSERVED", "SUPPORTED"]) expect(isClosedExperiment(open)).toBe(false);
  });

  it("no rule is re-implemented in the browser: the screens never compare evidence counts or gate transitions themselves", () => {
    expect(growth).not.toMatch(/observations?\.length\s*[<>=]|supports\s*[<>=]|CONFIRM_MIN|transitionRefusal/);
    expect(growth).not.toMatch(/ASPIRATION_ACHIEVE|ASPIRATION_RELEASE|ASPIRATION_UPDATE|CARD_|SESSION_LOG/);
  });
});
