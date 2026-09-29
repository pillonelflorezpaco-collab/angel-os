import { describe, it, expect, afterAll } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";

describe("database connection/config", () => {
  afterAll(async () => {
    await disconnectDb();
  });

  it("connects to Postgres and can run a trivial query", async () => {
    const db = getDb();
    const result = await db.$queryRawUnsafe<{ ok: number }[]>("SELECT 1 as ok");
    expect(result[0].ok).toBe(1);
  });

  it("has the expected tables from the migration", async () => {
    const db = getDb();
    const tables = await db.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const names = tables.map((t) => t.table_name);
    for (const expected of ["principals", "tasks", "reminders", "memories", "permissions", "audit_logs"]) {
      expect(names).toContain(expected);
    }
  });
});
