// The one source of "now" for approval expiry. Every expiry decision takes
// its time from here (and passes it into the SQL WHERE clause), so tests can
// move time deterministically instead of sleeping.

let override: (() => Date) | null = null;

export function now(): Date {
  return override ? override() : new Date();
}

/** Test seam. Pass null to restore the real clock. */
export function setClock(fn: (() => Date) | null): void {
  override = fn;
}
