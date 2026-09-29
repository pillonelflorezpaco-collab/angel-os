import { LocalMemoryProvider } from "./local/index.js";
import { Mem0MemoryProviderNotConfigured } from "./mem0/index.js";
import type { MemoryProvider } from "./types/index.js";

export * from "./types/index.js";

let provider: MemoryProvider | undefined;

/** Selects the MemoryProvider implementation from MEMORY_PROVIDER. Defaults to local. */
export function getMemoryProvider(): MemoryProvider {
  if (!provider) {
    const selected = process.env.MEMORY_PROVIDER ?? "local";
    provider = selected === "mem0" ? new Mem0MemoryProviderNotConfigured() : new LocalMemoryProvider();
  }
  return provider;
}
