// The model port for capture. A provider INTERPRETS text into candidate records; it never executes anything and is given no identity,
// no principal id, no database, no gateway handle and no credentials — only the user's words and a small read-only context of titles.
// Its output is untrusted (see schema.ts). No real provider is bundled: ScriptedModelProvider is deterministic test infrastructure.

export interface CaptureContext {
  /** ISO date the user is speaking on, so relative dates ("yesterday") can be resolved by the model. */
  today: string;
  timeZone: string;
  /** Titles only — enough to NAME an existing record. Ids are never given; the server resolves names. */
  goals: string[];
  projects: string[];
  decisions: string[];
  aspirations: string[];
  experiments: string[];
  openTasks: string[];
}

export interface InterpretInput { text: string; context: CaptureContext }
export type ModelInterpretation = unknown;

export interface CaptureModelProvider {
  readonly name: string;
  interpret(input: InterpretInput, signal: AbortSignal): Promise<ModelInterpretation>;
}

/** Deterministic stand-in: returns a scripted interpretation for a text (exact match, or a function). Records what it was given. */
export class ScriptedModelProvider implements CaptureModelProvider {
  readonly name = "scripted";
  readonly seen: InterpretInput[] = [];
  constructor(private readonly script: Record<string, ModelInterpretation> | ((input: InterpretInput) => ModelInterpretation | Promise<ModelInterpretation>)) {}
  async interpret(input: InterpretInput): Promise<ModelInterpretation> {
    this.seen.push(JSON.parse(JSON.stringify(input)));
    if (typeof this.script === "function") return this.script(input);
    return this.script[input.text] ?? { candidates: [] };
  }
}
