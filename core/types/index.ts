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
  | "activity.today"
  | "activity.week"
  | "unknown";

export interface Intent {
  name: IntentName;
  raw: string;
  slots: Record<string, string | undefined>;
}

export interface ContextPackage {
  currentTasks: { id: string; title: string; status: string }[];
  relevantMemories: { id: string; content: string; type: string; status: string; confirmed: boolean }[];
  /** Curated documents (slug) and structured knowledge items (`item:<id>`, with kind and contradiction flag). */
  relevantKnowledge: { slug: string; title: string; excerpt: string; kind?: string; contradicted?: boolean; confidence?: number | null }[];
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
  /**
   * The exact parameters of THIS request. For READ-lane requests they are
   * represented in audit as a canonical SHA-256 (`payloadHash`), never raw.
   * For actions (ActionDefinitions) the canonical, schema-validated
   * parameters are the ones stored, hashed and executed — this legacy
   * request type carries no mutation.
   */
  parameters: Record<string, unknown>;
  principalId: string;
}

export type ResultStatus = "EXECUTED" | "DENIED" | "PENDING_APPROVAL" | "FAILED";

export interface Result {
  status: ResultStatus;
  message: string;
  data?: unknown;
  approvalId?: string;
  /** The action really ran (status EXECUTED) but its audit row could not be written. */
  auditUnconfirmed?: boolean;
}
