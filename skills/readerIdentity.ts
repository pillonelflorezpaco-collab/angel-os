import { assertExplicitIdentity, type IdentityContext } from "../identity/index.js";
import type { Result } from "../core/types/index.js";

// READ skills derive the principal from an explicit, validated IdentityContext — never from a caller-supplied
// principalId parameter. A missing or malformed identity fails closed before anything is read.

export const IDENTITY_REQUIRED: Result = { status: "FAILED", message: "I can't do that without knowing who you are." };

export function readerIdentity(identity: IdentityContext | undefined): IdentityContext | null {
  try {
    return assertExplicitIdentity(identity);
  } catch {
    return null;
  }
}
