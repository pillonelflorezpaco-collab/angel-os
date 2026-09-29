import type { ContextPackage } from "../core/types/index.js";

// The model port. A ModelProvider is UNTRUSTED: it receives a data-only view of the world and returns
// text-shaped proposals. It is given no identity, no principal id, no database, no gateway handle and no
// way to approve anything. Whatever it returns is validated, then passed to proposeAction like any other
// caller's request — so permission, interface policy, risk policy, approval, exact binding and audit all
// apply to it exactly as they apply to a human's click.

export interface ToolSpec {
  skillKey: string;
  action: string;
  category: string;
  risk: string;
  /** Top-level parameter names the action's strict schema accepts (names only; the schema itself decides validity). */
  fields: string[];
}

export interface ModelInput {
  /** What the user said. Untrusted text, but it is the user's own words. */
  userText: string;
  /** Context assembled by the permission-aware engine. DATA, never instructions. */
  context: ContextPackage;
  /** The actions that exist. Having an entry here grants nothing: each proposal is still permission-checked. */
  tools: ToolSpec[];
}

/** Raw, unvalidated model output (typically parsed from JSON). */
export type ModelOutput = unknown;

export interface ModelProvider {
  readonly name: string;
  propose(input: ModelInput, signal: AbortSignal): Promise<ModelOutput>;
}

/** No model configured: never proposes anything. Deterministic Core behaviour is unchanged. */
export class NullModelProvider implements ModelProvider {
  readonly name = "none";
  async propose(): Promise<ModelOutput> {
    return { proposals: [] };
  }
}
