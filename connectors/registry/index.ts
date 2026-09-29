import type { ConnectorCapability, ConnectorProvider } from "../types/index.js";
import { UnknownConnectorError } from "../types/index.js";

/**
 * Discovery/infrastructure only — the registry never executes anything.
 * It answers "which connectors exist and what can they do", never
 * "do this action". Execution stays with Skills + the Gateway (see
 * docs/ARCHITECTURE.md "Connector vs Skill").
 */
export class ConnectorRegistry {
  private readonly providers = new Map<string, ConnectorProvider>();

  register(provider: ConnectorProvider): void {
    this.providers.set(provider.providerKey, provider);
  }

  get(providerKey: string): ConnectorProvider | undefined {
    return this.providers.get(providerKey);
  }

  getOrThrow(providerKey: string): ConnectorProvider {
    const provider = this.get(providerKey);
    if (!provider) throw new UnknownConnectorError(providerKey);
    return provider;
  }

  list(): ConnectorProvider[] {
    return Array.from(this.providers.values());
  }

  isAvailable(providerKey: string): boolean {
    return this.providers.has(providerKey);
  }

  listCapabilities(providerKey: string): ConnectorCapability[] {
    return this.getOrThrow(providerKey).listCapabilities();
  }
}

let registry: ConnectorRegistry | undefined;

/** Process-wide registry singleton, same pattern as db/client and memory/index.ts. */
export function getConnectorRegistry(): ConnectorRegistry {
  if (!registry) {
    registry = new ConnectorRegistry();
  }
  return registry;
}
