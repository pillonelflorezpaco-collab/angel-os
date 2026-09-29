import { z } from "zod";
import { listActionDefinitions, getActionDefinition } from "./registry.js";

// A read-only, name-level view of the action registry. It exposes what EXISTS (so a caller can describe it to a
// model) and nothing that can act: no execute, no schema object, no permission. Having an entry grants nothing.

export interface ActionSpec {
  skillKey: string;
  action: string;
  category: string;
  risk: string;
  /** Top-level parameter names the action's strict schema accepts. */
  fields: string[];
}

function shapeKeys(schema: unknown): string[] {
  let s: any = schema;
  for (let i = 0; i < 5 && s?._def && !(s instanceof z.ZodObject); i++) s = s._def.schema ?? s._def.innerType ?? s;
  return s instanceof z.ZodObject ? Object.keys(s.shape).sort() : [];
}

export function describeActions(): ActionSpec[] {
  return listActionDefinitions()
    .map((d) => ({ skillKey: d.skillKey, action: d.action, category: d.category, risk: d.risk, fields: shapeKeys(d.schema) }))
    .sort((a, b) => `${a.skillKey}|${a.action}`.localeCompare(`${b.skillKey}|${b.action}`));
}

export const hasAction = (skillKey: string, action: string): boolean => getActionDefinition(skillKey, action) !== undefined;
