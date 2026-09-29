import { JarvisCore } from "../core/index.js";
import { runWithIdentity, type IdentityContext } from "../identity/index.js";
import type { Result } from "../core/types/index.js";

// The ONE entry point every interface adapter uses to reach Angel OS:
//
//   Interface adapter → (identity already resolved) → dispatcher
//     → Jarvis Core → Context → Skill → Gateway → Data/Connector → Audit
//
// The principal comes only from the IdentityContext, which only an
// authenticator or a resolved external identity can create. An adapter
// passes text in and gets a Result out; it never chooses a principal,
// never touches the database, and never calls a skill directly.

/** Upper bound on a single user message, so no interface can push unbounded text through Jarvis. */
export const MAX_INPUT_CHARS = 2000;

const jarvis = new JarvisCore();

export async function handleInterfaceMessage(identity: IdentityContext, input: string): Promise<Result> {
  if (!input.trim()) return { status: "FAILED", message: "I didn't get a message." };
  if (input.length > MAX_INPUT_CHARS) return { status: "FAILED", message: "That message is too long. Please shorten it." };
  return runWithIdentity(identity, () => jarvis.handle({ principalId: identity.principalId, input, identity }));
}
