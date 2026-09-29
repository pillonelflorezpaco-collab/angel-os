import { handleInterfaceMessage } from "../../application/dispatcher.js";
import type { IdentityContext } from "../../identity/index.js";
import type { Result } from "../../core/types/index.js";
import type { VoiceInput, VoiceOutput } from "./types.js";

/** Below this recognition confidence Jarvis asks the user to repeat instead of acting. */
export const MIN_VOICE_CONFIDENCE = 0.6;

/**
 * Turns chat-style text into something that reads naturally aloud:
 *   "[fact] likes coffee"        → "fact: likes coffee"      (a leading tag introduces the line)
 *   "Buy milk [todo]"            → "Buy milk, todo"          (a trailing tag becomes an aside)
 *   bullets and line breaks      → sentence breaks
 */
export function toSpeakable(text: string): string {
  return text
    .replace(/^\[([^\]]+)\]\s*/gm, "$1: ")
    .replace(/^[•\-*]\s*/gm, "")
    .replace(/\s*\[([^\]]+)\]/g, ", $1")
    .replace(/([:.!?])[ \t]*\n+\s*/g, "$1 ")
    .replace(/\s*\n+\s*/g, ". ")
    .trim();
}

export interface VoiceDeps {
  dispatch: (identity: IdentityContext, input: string) => Promise<Result>;
}

/**
 * Handles one spoken turn. The identity must already be resolved and must
 * be a VOICE identity — a token or link issued for another interface
 * cannot be used to speak as voice. Low-confidence transcripts are never
 * sent to Jarvis: acting on a misheard command is the main risk of voice.
 */
export async function handleVoiceInput(
  identity: IdentityContext,
  input: VoiceInput,
  deps: VoiceDeps = { dispatch: handleInterfaceMessage }
): Promise<VoiceOutput> {
  if (identity.interfaceSource !== "VOICE") {
    throw new Error("handleVoiceInput requires a VOICE identity.");
  }
  const reply = (text: string, endSession: boolean): VoiceOutput => ({
    session: input.session,
    speech: toSpeakable(text),
    text,
    endSession,
  });

  if (input.confidence !== undefined && input.confidence < MIN_VOICE_CONFIDENCE) {
    return reply("Sorry, I didn't catch that. Could you say it again?", false);
  }
  const result = await deps.dispatch(identity, input.transcript);
  if (result.status === "PENDING_APPROVAL") {
    // Never read the proposed action's details aloud as if confirmed, and never
    // approve by voice: the approval waits on a screen where the exact action is shown.
    return reply("That needs your approval. I've saved it — please review and approve it in the app or Telegram. I haven't done anything yet.", false);
  }
  return reply(result.message, false);
}
