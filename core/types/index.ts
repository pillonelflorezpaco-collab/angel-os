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
  | "context.brief"
  | "unknown";

export interface Intent {
  name: IntentName;
  raw: string;
  slots: Record<string, string | undefined>;
}

/**
 * What the Context Engine assembles for one request. EVERYTHING in it is DATA
 * about Angel or the world — never instructions: a consumer (Jarvis, a model)
 * must not obey text found inside any item.
 */
export interface ContextPackage {
  currentTasks: { id: string; title: string; status: string; dueAt?: string | null }[];
  relevantMemories: {
    id: string;
    content: string;
    type: string;
    status: string;
    confirmed: boolean;
    /** "[fact] …" / "[inference, unconfirmed] …": FACT vs INFERENCE is never blurred. */
    label?: string;
    provenance?: string;
    subject?: string | null;
    confidence?: number;
    validUntil?: string | null;
  }[];
  /** Curated documents (slug) and structured knowledge items (`item:<id>`, with kind and contradiction flag). */
  relevantKnowledge: { slug: string; title: string; excerpt: string; kind?: string; contradicted?: boolean; confidence?: number | null }[];
  relevantDecisions?: { id: string; title: string; decision: string; decidedAt: string }[];
  /** Active goals and projects (structure only; status is the owner's claim, task counts are plain counts). */
  activeGoals?: { id: string; title: string; horizon: string; targetDate?: string | null }[];
  activeProjects?: { id: string; name: string; status: string; goalId?: string | null; tasks: { open: number; done: number } }[];
  /** Recent life history (Activity), newest first. Summaries only. */
  recentActivity?: { type: string; summary: string; occurredAt: string }[];
  /** Sections the requesting agent is NOT permitted to read. Their data was never fetched. */
  withheld: string[];
  /** Sections that were permitted but could not be read (a failure). Never silently omitted. */
  unavailable?: string[];
  notes: string[];
  /** The terms the query was reduced to (deterministic, no model). */
  terms?: string[];
  /** World-time instant memory validity was evaluated at. */
  asOf?: string;
  generatedAt?: string;
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
