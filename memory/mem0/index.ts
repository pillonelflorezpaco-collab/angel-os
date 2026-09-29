// Mem0 integration point — NOT active by default in v0.1.
//
// Rationale (see docs/MEMORY.md): wiring the rest of Angel OS directly to
// Mem0 would make the application fragile to that one vendor. Instead, the
// application depends only on MemoryProvider (memory/types/index.ts).
// LocalMemoryProvider (memory/local) is the default, Postgres-backed
// implementation. This file documents and stubs the shape a Mem0-backed
// provider would take, so swapping it in later is a config change
// (MEMORY_PROVIDER=mem0 + MEM0_API_KEY), not a rewrite.
//
// To implement for real: install the mem0ai SDK, translate MemoryRecord
// <-> Mem0's memory objects, and map searchMemory to Mem0's semantic
// search. Left unimplemented here deliberately — no fake/partial network
// calls, no invented API shapes.

import type { MemoryProvider } from "../types/index.js";

export class Mem0MemoryProviderNotConfigured implements MemoryProvider {
  private readonly reason =
    "Mem0MemoryProvider is not implemented in v0.1. Set MEMORY_PROVIDER=local " +
    "(default) to use the Postgres-backed provider, or implement this adapter " +
    "against memory/types/index.ts's MemoryProvider interface.";

  async addMemory(): Promise<never> {
    throw new Error(this.reason);
  }
  async searchMemory(): Promise<never> {
    throw new Error(this.reason);
  }
  async updateMemory(_principalId: string, _id: string): Promise<never> {
    throw new Error(this.reason);
  }
  async getMemory(): Promise<never> {
    throw new Error(this.reason);
  }
  async listRevisions(): Promise<never> {
    throw new Error(this.reason);
  }
  async retractMemory(): Promise<never> {
    throw new Error(this.reason);
  }
  async deleteMemory(_principalId: string, _id: string): Promise<never> {
    throw new Error(this.reason);
  }
  async confirmMemory(_principalId: string, _id: string): Promise<never> {
    throw new Error(this.reason);
  }
}
