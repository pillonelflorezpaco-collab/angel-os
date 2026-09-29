import { getDb } from "../db/client/index.js";

export interface PrincipalProfile {
  id: string;
  name: string;
  timezone: string;
}

/** A principal's own basic profile, for `GET /api/me`. Only ever called with the authenticated principal's id. */
export async function getPrincipalProfile(principalId: string): Promise<PrincipalProfile | null> {
  const p = await getDb().principal.findUnique({ where: { id: principalId }, select: { id: true, name: true, timezone: true } });
  return p;
}
