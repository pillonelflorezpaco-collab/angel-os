import { getDb } from "./client/index.js";
import type { CursorStore } from "../interfaces/telegram/poller.js";

/** Database-backed polling position for one interface, keyed by (interface, name). */
export class DbCursorStore implements CursorStore {
  constructor(private readonly interfaceSource: string, private readonly name: string) {}

  async get(): Promise<number | null> {
    const row = await getDb().interfaceCursor.findUnique({
      where: { interfaceSource_name: { interfaceSource: this.interfaceSource, name: this.name } },
    });
    return row ? Number(row.value) : null;
  }

  async advance(updateId: number): Promise<void> {
    const db = getDb();
    await db.interfaceCursor.createMany({
      data: [{ interfaceSource: this.interfaceSource, name: this.name, value: BigInt(updateId) }],
      skipDuplicates: true,
    });
    // Only ever forward.
    await db.interfaceCursor.updateMany({
      where: { interfaceSource: this.interfaceSource, name: this.name, value: { lt: BigInt(updateId) } },
      data: { value: BigInt(updateId) },
    });
  }
}
