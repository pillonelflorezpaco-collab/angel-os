import { proposeAction, describeActions, hasAction } from "../../gateway/index.js";
import type { ActionSpec } from "../../gateway/index.js";
import type { IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";

// The single doorway for MODEL-originated proposals. It exists so the orchestration layer never touches the
// gateway's registry or execution engine directly (the boundary tests require every proposal to come through a
// skill). A model proposal is exactly a human proposal: proposeAction(identity, …) — permission, interface policy,
// risk policy, approval, exact binding and audit all apply. Only registered ActionDefinitions are proposable;
// there is no way from here to read data, approve, or decide anything.

export const isProposable = hasAction;
export const listProposableActions = (): ActionSpec[] => describeActions();

export function proposeFromModel(identity: IdentityContext, proposal: { skillKey: string; action: string; parameters: Record<string, unknown> }): Promise<Result> {
  return proposeAction(identity, { skillKey: proposal.skillKey, action: proposal.action, parameters: proposal.parameters });
}
