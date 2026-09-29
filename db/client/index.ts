import { PrismaClient } from "@prisma/client";

// Single shared Prisma client. Postgres is the single source of truth for
// all structured state — no module should open its own connection.
let client: PrismaClient | undefined;

export function getDb(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
