// Core types for Jarvis Core's deterministic v0.1 pipeline:
//   Input -> Intent -> Context -> Plan -> Action -> Result

export type IntentName =
  | "task.create"
  | "task.list"
  | "reminder.create"
  | "reminder.list"
  | "memory.remember"
  | "memory.search"
  | "decision.query"
  | "calendar.today"
  | "unknown";

export interface Intent {
  name: IntentName;
  raw: string;
  slots: Record<string, string | undefined>;
}

export interface ContextPackage {
  currentTasks: { id: string; title: string; status: string }[];
  relevantMemories: { id: string; content: string; type: string; status: string; confirmed: boolean }[];
  relevantKnowledge: { slug: string; title: string; excerpt: string }[];
  /** Sections not included because the requesting agent lacks permission. Their data was never fetched. */
  withheld: string[];
  notes: string[];
}

export interface Plan {
  intent: Intent;
  skillKey: string;
  action: string;
  resource: string;
  parameters: Record<string, unknown>;
}

export interface ActionRequest {
  agentKey: string;
  skillKey: string;
  resource: string;
  action: string;
  parameters: Record<string, unknown>;
  principalId: string;
}

export type ResultStatus = "EXECUTED" | "DENIED" | "PENDING_APPROVAL" | "FAILED";

export interface Result {
  status: ResultStatus;
  message: string;
  data?: unknown;
  approvalId?: string;
}
