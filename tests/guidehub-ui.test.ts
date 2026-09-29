import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { GRADES, approvalOutcome, countdown, learningLine, listFrom, memoryLine, progressLabel, riskLabel, sectionNotices, writeOutcome } from "../guidehub/public/lib.js";

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

describe("frontend safety (static checks)", () => {
  const app = read("app.js");
  it("nothing from the API is ever parsed as HTML or executed", () => {
    for (const f of ["app.js", "lib.js"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|srcdoc|dangerouslySet/);
    }
  });
  it("the page has no inline script, no inline handler and no inline style (so the CSP can forbid them)", () => {
    const html = read("index.html");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/https?:\/\//i); // no third-party origins at all
    expect(read("styles.css")).not.toMatch(/@import|url\(\s*["']?https?:/i);
  });
  it("the UI never handles a principal id, a bearer token, or storage of secrets", () => {
    for (const f of ["app.js", "lib.js"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/principalId|Authorization|Bearer|aos_|localStorage|sessionStorage|document\.cookie/);
    }
  });
  it("children are swapped in only through mount(), which drops null/false sections (a raw replaceChildren prints the word 'null')", () => {
    expect(app.match(/replaceChildren\((?!\))/g)).toHaveLength(1); // the single call inside mount()
    expect(app).toMatch(/const mount = \(box, \.\.\.nodes\) => box\.replaceChildren\(\.\.\.nodes\.flat\(\)\.filter\(/);
  });
  it("every state-changing call goes through the one api() wrapper that adds the CSRF header", () => {
    expect(app.match(/fetch\(/g)).toHaveLength(1);
    expect(app).toMatch(/headers: \{ \.\.\.CSRF/);
  });
  it("it only ever calls the routes the cockpit proxy allows", async () => {
    const { matchRule } = await import("../guidehub/proxy.js");
    const called = [...app.matchAll(/api\(\s*"(GET|POST|DELETE)"\s*,\s*([`"])([^`"]+)\2/g)].map((m) => [m[1], m[3]] as const);
    expect(called.length).toBeGreaterThan(8);
    for (const [method, raw] of called) {
      const p = raw.split("?")[0];
      if (p === "/session") continue; // the BFF's own route
      const concrete = p.replace(/\$\{a\.id\}/g, "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e").replace("${decision}", "approve");
      expect(matchRule(method, concrete), `${method} ${raw}`).toBeDefined();
    }
  });
  it("the shipped public directory contains only the expected static files", () => {
    expect(readdirSync(PUB).sort()).toEqual(["app.js", "index.html", "lib.d.ts", "lib.js", "styles.css"]);
  });
});
