import { logInternalError } from "../../core/errors.js";
import { recordAuditEvent } from "./index.js";

/** Writes an audit row; on failure logs internally and returns false instead of throwing. */
export async function safeAudit(input: Parameters<typeof recordAuditEvent>[0]): Promise<boolean> {
  try {
    await recordAuditEvent(input);
    return true;
  } catch (err) {
    logInternalError("audit.write", err);
    return false;
  }
}
