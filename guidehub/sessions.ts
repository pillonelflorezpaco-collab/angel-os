import { randomBytes } from "node:crypto";

// Server-side sessions. The cookie carries only an unguessable 256-bit id; everything else lives here, so logout and
// expiry are real (a stolen id stops working the moment the session is deleted). A restart signs everyone out — safe by default.

export interface SessionStoreOptions { maxAgeMs: number; idleMs: number; maxSessions?: number; now?: () => number }
interface Session { createdAt: number; lastSeenAt: number }

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  constructor(private readonly opts: SessionStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.maxSessions = opts.maxSessions ?? 20;
  }

  create(): string {
    this.sweep();
    while (this.sessions.size >= this.maxSessions) this.sessions.delete(this.sessions.keys().next().value as string); // evict the oldest
    const id = randomBytes(32).toString("base64url");
    const t = this.now();
    this.sessions.set(id, { createdAt: t, lastSeenAt: t });
    return id;
  }

  /** True (and refreshes the idle timer) only for a live session; expired ones are deleted. */
  touch(id: string | undefined): boolean {
    if (!id) return false;
    const s = this.sessions.get(id);
    if (!s) return false;
    const t = this.now();
    if (t - s.createdAt > this.opts.maxAgeMs || t - s.lastSeenAt > this.opts.idleMs) {
      this.sessions.delete(id);
      return false;
    }
    s.lastSeenAt = t;
    return true;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  size(): number { this.sweep(); return this.sessions.size; }

  private sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (t - s.createdAt > this.opts.maxAgeMs || t - s.lastSeenAt > this.opts.idleMs) this.sessions.delete(id);
  }
}
