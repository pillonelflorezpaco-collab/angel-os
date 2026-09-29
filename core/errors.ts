// User-facing error safety. Only errors deliberately marked PublicError
// may show their message to the user or record it in an audit entry.
// Everything else is reduced to a generic message plus structured, safe
// fields (error type, database error code).

/** An error whose message was written to be shown to the user. Never put secrets, SQL, paths, or raw provider text in one. */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export const GENERIC_ERROR_MESSAGE = "Something went wrong while doing that. Nothing was changed by the failed step.";

export interface SafeErrorInfo {
  /** Safe to show the user. */
  publicMessage: string;
  /** Safe structured metadata for the audit log: error class name and, if present, a database error code. Never the raw message. */
  audit: { errorType: string; code?: string; public: boolean };
}

export function toSafeError(err: unknown): SafeErrorInfo {
  if (err instanceof PublicError) {
    return { publicMessage: err.message, audit: { errorType: err.name, public: true } };
  }
  const errorType = err instanceof Error ? err.name || "Error" : typeof err;
  const code =
    err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
      ? ((err as { code: string }).code.slice(0, 32))
      : undefined;
  return { publicMessage: GENERIC_ERROR_MESSAGE, audit: { errorType, ...(code ? { code } : {}), public: false } };
}

const REDACTIONS: [RegExp, string][] = [
  [/(postgres(?:ql)?:\/\/)[^\s@]*@/gi, "$1[redacted]@"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/ya29\.[A-Za-z0-9._-]+/g, "[redacted-google-token]"],
  [/GOCSPX-[A-Za-z0-9_-]+/g, "[redacted-google-secret]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted-private-key]"],
  [/((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]"],
];

/** Best-effort redaction for developer-log output only. Not a substitute for keeping secrets out of errors. */
export function redactForLog(text: string): string {
  return REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

/** Writes an unexpected error to the developer log (stderr), redacted. Silent under test to keep output clean. */
export function logInternalError(context: string, err: unknown): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const detail = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
  // eslint-disable-next-line no-console
  console.error(`[angel-os] ${context}: ${redactForLog(detail)}`);
}
