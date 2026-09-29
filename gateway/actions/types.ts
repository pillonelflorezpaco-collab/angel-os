import type { z } from "zod";
import type { ActionCategory } from "@prisma/client";

// The execution boundary. Nothing that acts on the world is a bare closure:
// it is an ActionDefinition registered with the gateway, invoked only by the
// execution engine with parameters that were validated (and, if approval was
// needed, bound to a stored approval).
//
//   LLM / Core PROPOSES  →  Gateway PERMITS  →  user APPROVES  →  execution layer ACTS

export type RiskLevel = "LOW" | "SENSITIVE" | "DANGEROUS";

/** Passed to every execute(); the only context an action gets. */
export interface ExecutionContext {
  readonly principalId: string;
  readonly agentKey: string;
  readonly interfaceSource: string;
  readonly requestId: string;
  /** Stable per approved action (the approval id). Pass it to external providers so a retry cannot duplicate the effect. */
  readonly idempotencyKey: string;
  readonly approvalId?: string;
}

export interface ActionDefinition<P = unknown> {
  skillKey: string;
  /** Permission action + audit name, e.g. "SEND_EMAIL". */
  action: string;
  resource: string;
  category: ActionCategory;
  risk: RiskLevel;
  /** Agent the permission is checked for. */
  agentKey: string;
  /** Strict schema: unknown keys are rejected, so nothing rides along unvalidated. */
  schema: z.ZodType<P, z.ZodTypeDef, unknown>;
  /** One safe, human-readable line shown when asking for approval. Must not include secrets. */
  describe(params: P): string;
  /** How long a proposal stays approvable, in milliseconds. */
  approvalTtlMs?: number;
  /** Performs the action. Throw PublicError for user-safe failures. */
  execute(ctx: ExecutionContext, params: P): Promise<unknown>;
  /** User-safe success line; defaults to "Done." */
  successMessage?(result: unknown, params: P): string;
}

export interface ActionProposal {
  skillKey: string;
  action: string;
  parameters: unknown;
}
