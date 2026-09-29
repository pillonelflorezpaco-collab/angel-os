import { gatewayExecute } from "../../gateway/index.js";
import { listActivities, summarizeActivities } from "../../activity/service.js";
import { localRangeBounds, formatLocalTime, type LocalRange } from "../../core/time.js";
import { getPrincipalTimeZone } from "./principal.js";
import type { ActivityType } from "@prisma/client";
import type { Result } from "../../core/types/index.js";

// Reads of the activity stream go through the gateway like every other
// protected read: permission-checked for the requesting agent and audited.
// (Writing activity is not gated separately — it is the record of an
// action that was already permitted; see activity/service.ts.)

export const SKILL_KEY = "system.activity";
export const RESOURCE = "angel:activity";
const ACTION = "ACTIVITY_READ";

const RANGE_LABEL: Record<LocalRange, string> = { today: "Today", yesterday: "Yesterday", week: "This week" };

function label(type: string): string {
  return type.toLowerCase().replace(/_/g, " ");
}

export interface ActivityQueryInput {
  principalId: string;
  agentKey: string;
  range: LocalRange;
  types?: ActivityType[];
  limit?: number;
}

export async function listActivity(input: ActivityQueryInput): Promise<Result> {
  const result = await gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: ACTION,
      parameters: { range: input.range, types: input.types ?? null, limit: input.limit ?? null },
    },
    async () => {
      const timeZone = await getPrincipalTimeZone(input.principalId);
      const { start, end } = localRangeBounds(new Date(), timeZone, input.range);
      const activities = await listActivities(input.principalId, { from: start, to: end }, { types: input.types, limit: input.limit });
      return { timeZone, activities };
    },
    "skill.system.activity"
  );
  if (result.status !== "EXECUTED") return result;
  const { timeZone, activities } = result.data as { timeZone: string; activities: Awaited<ReturnType<typeof listActivities>> };
  const header = RANGE_LABEL[input.range];
  return {
    status: "EXECUTED",
    message: activities.length
      ? `${header} — ${activities.length} ${activities.length === 1 ? "activity" : "activities"}:\n` +
        activities.map((a) => `• ${formatLocalTime(a.occurredAt, timeZone)} ${a.summary}`).join("\n")
      : `${header}: nothing recorded yet.`,
    data: activities,
  };
}

export async function summarizeActivity(input: Omit<ActivityQueryInput, "types" | "limit">): Promise<Result> {
  const result = await gatewayExecute(
    {
      principalId: input.principalId,
      agentKey: input.agentKey,
      skillKey: SKILL_KEY,
      resource: RESOURCE,
      action: ACTION,
      parameters: { range: input.range, summary: true },
    },
    async () => {
      const timeZone = await getPrincipalTimeZone(input.principalId);
      const { start, end } = localRangeBounds(new Date(), timeZone, input.range);
      const summary = await summarizeActivities(input.principalId, { from: start, to: end });
      return { range: input.range, timeZone, from: start, to: end, ...summary };
    },
    "skill.system.activity"
  );
  if (result.status !== "EXECUTED") return result;
  const s = result.data as { total: number; byType: Record<string, number>; byArea: Record<string, number> };
  const header = RANGE_LABEL[input.range];
  if (s.total === 0) return { ...result, message: `${header}: nothing recorded yet.` };
  const types = Object.entries(s.byType).map(([t, n]) => `${label(t)} ×${n}`).join(", ");
  const areas = Object.entries(s.byArea).map(([a, n]) => `${a} ×${n}`).join(", ");
  return { ...result, message: `${header}: ${s.total} recorded. ${types}.${areas ? ` Areas: ${areas}.` : ""}` };
}
