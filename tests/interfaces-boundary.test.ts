import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Architecture rules, enforced mechanically. The multi-interface design only
// holds if adapters stay thin: they authenticate, translate, and call ONE
// entry point. If any of these fail, someone has put business logic or data
// access where it doesn't belong.

const ROOT = path.resolve(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? tsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/** Runtime import specifiers (type-only imports are erased and can't carry behaviour). */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  const specs: string[] = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
    if (!m[1]) specs.push(m[2]);
  }
  for (const m of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

function violations(dir: string, forbidden: RegExp): string[] {
  return tsFiles(path.join(ROOT, dir)).flatMap((file) =>
    runtimeImports(file)
      .filter((spec) => forbidden.test(spec))
      .map((spec) => `${path.relative(ROOT, file)} imports "${spec}"`)
  );
}

describe("interface boundary rules", () => {
  it("interfaces/ never touch the database, skills, the gateway, memory, knowledge, context, or connectors", () => {
    expect(violations("interfaces", /(^|\/)(db|skills|gateway|memory|knowledge|context|connectors)(\/|$)|@prisma\/client/)).toEqual([]);
  });

  it("interfaces/ may only depend on identity/, core/, and themselves (paths resolved, not pattern-matched)", () => {
    const allowedTop = new Set(["identity", "core", "interfaces", "application"]);
    const offenders = tsFiles(path.join(ROOT, "interfaces")).flatMap((file) =>
      runtimeImports(file)
        .filter((spec) => spec.startsWith("."))
        .filter((spec) => !allowedTop.has(path.relative(ROOT, path.resolve(path.dirname(file), spec)).split(path.sep)[0]))
        .map((spec) => `${path.relative(ROOT, file)} imports "${spec}"`)
    );
    expect(offenders).toEqual([]);
  });

  it("interfaces/ import no third-party packages except Node built-ins", () => {
    const offenders = tsFiles(path.join(ROOT, "interfaces")).flatMap((file) =>
      runtimeImports(file).filter((spec) => !spec.startsWith(".") && !spec.startsWith("node:")).map((spec) => `${path.relative(ROOT, file)} imports "${spec}"`)
    );
    expect(offenders).toEqual([]);
  });

  it("application/ has no database, skills, memory, knowledge, or connector access (it reaches data only through the gateway or the context engine, which itself reads only through skills)", () => {
    expect(violations("application", /(^|\/)(db|skills|memory|knowledge|connectors)(\/|$)|@prisma\/client/)).toEqual([]);
  });

  it("api/ has no database access and no direct memory/knowledge/context access", () => {
    expect(violations("api", /(^|\/)(db|memory|knowledge|context)(\/|$)|@prisma\/client/)).toEqual([]);
  });

  it("core/ has no database or memory access", () => {
    expect(violations("core", /(^|\/)(db|memory)(\/|$)|@prisma\/client/)).toEqual([]);
  });

  it("no adapter reads a principal from a request field", () => {
    const files = [...tsFiles(path.join(ROOT, "interfaces")), path.join(ROOT, "api/server.ts")];
    const offenders = files.filter((f) => /req\.(body|query|params|headers)\S*principal/i.test(readFileSync(f, "utf-8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("the boundary check itself works: it would catch a violation", () => {
    const sample = `import { getDb } from "../../db/client/index.js";\nimport type { X } from "../../db/types.js";`;
    const found = [...sample.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].filter((m) => !m[1]).map((m) => m[2]);
    expect(found).toEqual(["../../db/client/index.js"]);
    expect(/(^|\/)(db)(\/|$)/.test(found[0])).toBe(true);
  });
});
