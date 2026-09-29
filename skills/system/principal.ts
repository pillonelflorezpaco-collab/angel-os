import { getDb } from "../../db/client/index.js";
import { normalizeTimeZone } from "../../core/time.js";

/**
 * The principal's configured IANA timezone, falling back to UTC if unset
 * or invalid. Only skills call this (Core never touches Prisma), and only
 * from inside a gatewayExecute executor, after permission has cleared.
 */
export async function getPrincipalTimeZone(principalId: string): Promise<string> {
  const principal = await getDb().principal.findUnique({ where: { id: principalId }, select: { timezone: true } });
  return normalizeTimeZone(principal?.timezone);
}
