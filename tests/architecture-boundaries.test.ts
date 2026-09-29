import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// BUILD #7: import/usage boundaries for the execution architecture. Cheap,
// mechanical, and meant to fail loudly when a future change introduces a
// second way to execute, a transport-aware core, or a back door to a
// privileged primitive. (tests/interfaces-boundary.test.ts holds the
// adapter/API/Core/application rules; these are the execution-path ones.)

const ROOT = path.resolve(import.meta.dirname, "..");
const PRODUCTION_DIRS = ["core", "skills", "gateway", "interfaces", "application", "api", "identity", "activity", "reminders", "connectors", "memory", "context", "knowledge", "db"];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const full = path.join(dir, n);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const production = PRODUCTION_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = new Map(production.map((f) => [rel(f), stripComments(readFileSync(f, "utf-8"))]));

function runtimeImports(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) if (!m[1]) specs.push(m[2]);
  for (const m of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(m[1]);
  return specs;
}
/** Files (relative paths) that runtime-import a module whose resolved path matches. */
function importersOf(target: RegExp): string[] {
  return [...code.entries()]
    .filter(([file, src]) => runtimeImports(src).some((s) => s.startsWith(".") && target.test(path.posix.normalize(path.posix.join(path.posix.dirname(file), s)))))
    .map(([file]) => file);
}
const filesMentioning = (identifier: RegExp) => [...code.entries()].filter(([, src]) => identifier.test(src)).map(([f]) => f);
const outside = (files: string[], allowed: RegExp) => files.filter((f) => !allowed.test(f));

describe("execution-path architecture boundaries", () => {
  it("the execution engine (gateway/execution, approval state/expiry/service, action registry) is used only inside gateway/ — plus the manifest for registration", () => {
    expect(outside(importersOf(/^gateway\/execution(\.js)?$/), /^gateway\//)).toEqual([]);
    expect(outside(importersOf(/^gateway\/approvals\/(state|expiry|service)(\.js)?$/), /^gateway\//)).toEqual([]);
    expect(outside(importersOf(/^gateway\/actions\/registry(\.js)?$/), /^(gateway\/|skills\/manifest\.ts$)/)).toEqual([]);
  });

  it("gatewayExecute is called only by skills/ (and defined in gateway/); nothing else opens a legacy execution path", () => {
    expect(outside(filesMentioning(/\bgatewayExecute\b/), /^(gateway\/|skills\/)/)).toEqual([]);
  });

  it("proposeAction is proposed only from skills/ (Core, adapters and the API go through a skill)", () => {
    expect(outside(filesMentioning(/\bproposeAction\b/), /^(gateway\/|skills\/)/)).toEqual([]);
  });

  it("permissions are changed only inside gateway/ (setPermission)", () => {
    expect(outside(filesMentioning(/\bsetPermission\b/), /^gateway\//)).toEqual([]);
  });

  it("registerAction is called only by the skills manifest", () => {
    expect(outside(filesMentioning(/\bregisterAction\(/), /^(gateway\/actions\/registry\.ts|skills\/manifest\.ts)$/)).toEqual([]);
  });

  it("runAction (the raw execution primitive) is never reachable outside gateway/", () => {
    expect(outside(filesMentioning(/\brunAction\b/), /^gateway\//)).toEqual([]);
  });

  it("Core reaches actions only through skills: no gateway, database, connector or transport import", () => {
    const offenders = [...code.entries()]
      .filter(([f]) => f.startsWith("core/"))
      .flatMap(([f, src]) => runtimeImports(src).filter((s) => /(^|\/)(gateway|db|memory|connectors|interfaces|api|reminders)(\/|$)|@prisma\/client/.test(s)).map((s) => `${f} imports ${s}`));
    expect(offenders).toEqual([]);
  });

  it("skills never depend on an interface, the API, or the application layer", () => {
    const offenders = [...code.entries()]
      .filter(([f]) => f.startsWith("skills/"))
      .flatMap(([f, src]) => runtimeImports(src).filter((s) => /(^|\/)(interfaces|api|application|reminders)(\/|$)/.test(s)).map((s) => `${f} imports ${s}`));
    expect(offenders).toEqual([]);
  });

  it("the reminder engine is transport-neutral: no interfaces/, api/, connectors/ import and no Telegram or HTTP client", () => {
    const files = [...code.entries()].filter(([f]) => f.startsWith("reminders/"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap(([f, src]) => [
      ...runtimeImports(src).filter((s) => /(^|\/)(interfaces|api|connectors|skills)(\/|$)/.test(s)).map((s) => `${f} imports ${s}`),
      ...(/telegram|api\.telegram\.org|\bfetch\(/i.test(src) ? [`${f} mentions a transport`] : []),
    ]);
    expect(offenders).toEqual([]);
  });

  it("only interfaces/telegram talks to the Telegram Bot API", () => {
    expect(outside(filesMentioning(/api\.telegram\.org/), /^interfaces\/telegram\//)).toEqual([]);
  });

  it("the outbound port lives in application/ and imports nothing but identity types (no transport, no DB)", () => {
    const src = code.get("application/delivery.ts")!;
    expect(runtimeImports(src)).toEqual([]);
  });

  it("nothing outside db/, identity/, gateway/, skills/, memory/, connectors/, activity/, reminders/, context/ opens a database connection", () => {
    expect(outside(filesMentioning(/\bgetDb\b|@prisma\/client/), /^(db|identity|gateway|skills|memory|connectors|activity|reminders|context)\//).filter((f) => !/^skills\/.*\.ts$/.test(f))).toEqual([]);
  });

  describe("the checkers themselves work", () => {
    it("importersOf finds a real importer and would flag a violation", () => {
      expect(importersOf(/^gateway\/actions\/registry(\.js)?$/)).toContain("skills/manifest.ts");
      expect(outside(["core/x.ts", "gateway/y.ts"], /^gateway\//)).toEqual(["core/x.ts"]);
    });
    it("comment stripping keeps documentation mentions from tripping the rules", () => {
      expect(/\bgatewayExecute\b/.test(stripComments("// gatewayExecute is legacy\n/* gatewayExecute */ const a = 1;"))).toBe(false);
      expect(/\bgatewayExecute\b/.test(stripComments("await gatewayExecute(x)"))).toBe(true);
    });
  });
});
