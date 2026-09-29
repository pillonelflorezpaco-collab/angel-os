// The voice abstraction. Angel OS knows nothing about Google Home, Alexa,
// a phone assistant, or any specific device. A device-specific adapter
// (owned outside the core) converts its vendor's request into a
// VoiceInput and a VoiceOutput back into its vendor's response:
//
//   Voice device → Voice adapter → VoiceInput → Angel OS (dispatcher → Jarvis)
//                                                    ↓
//   Voice device ← Voice adapter ← VoiceOutput ← Result
//
// Swapping the device means writing a new adapter. Nothing else changes.

/** One continuous spoken conversation with one device. */
export interface VoiceSession {
  id: string;
  /** Stable identifier of the physical/virtual device. */
  deviceId: string;
  locale?: string;
  startedAt: Date;
}

/** What the speech-to-text step produced. */
export interface VoiceInput {
  session: VoiceSession;
  transcript: string;
  /** Speech-recognition confidence, 0–1, if the device reports it. */
  confidence?: number;
}

/** What the device should say, and whether the conversation is over. */
export interface VoiceOutput {
  session: VoiceSession;
  /** Written to be spoken aloud: no brackets, bullets, or line breaks. */
  speech: string;
  /** The same reply as chat text, for devices with a screen. */
  text: string;
  endSession: boolean;
}

/** The two device-specific translations a voice adapter provides. */
export interface VoiceDeviceAdapter<RawRequest = unknown, RawResponse = unknown> {
  parseRequest(raw: RawRequest): VoiceInput;
  renderResponse(output: VoiceOutput): RawResponse;
}
