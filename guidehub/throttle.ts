// Sign-in attempt limiter: a fixed window per key (client address) plus a global window, so a distributed guesser is slowed too.
// Successful sign-in clears that client's counter, never the global one. In-memory: a restart resets it (acceptable for a single-owner cockpit).

export interface ThrottleOptions { perKeyMax: number; globalMax: number; windowMs: number; now?: () => number }
interface Bucket { count: number; resetAt: number }

export class LoginThrottle {
  private readonly keys = new Map<string, Bucket>();
  private global: Bucket = { count: 0, resetAt: 0 };
  private readonly now: () => number;
  constructor(private readonly o: ThrottleOptions) { this.now = o.now ?? Date.now; }

  /** Seconds to wait, or 0 if an attempt is allowed. */
  retryAfterSec(key: string): number {
    const t = this.now();
    const k = this.live(this.keys.get(key), t);
    const g = this.live(this.global, t);
    const waits: number[] = [];
    if (k && k.count >= this.o.perKeyMax) waits.push(k.resetAt - t);
    if (g && g.count >= this.o.globalMax) waits.push(g.resetAt - t);
    return waits.length ? Math.max(1, Math.ceil(Math.max(...waits) / 1000)) : 0;
  }

  recordFailure(key: string): void {
    const t = this.now();
    this.bump(this.keys, key, t);
    if (!this.live(this.global, t)) this.global = { count: 0, resetAt: t + this.o.windowMs };
    this.global.count++;
    if (this.keys.size > 1000) for (const [k, b] of this.keys) if (b.resetAt <= t) this.keys.delete(k);
  }

  recordSuccess(key: string): void { this.keys.delete(key); }

  private live(b: Bucket | undefined, t: number): Bucket | undefined { return b && b.resetAt > t ? b : undefined; }
  private bump(map: Map<string, Bucket>, key: string, t: number): void {
    const b = this.live(map.get(key), t) ?? { count: 0, resetAt: t + this.o.windowMs };
    b.count++;
    map.set(key, b);
  }
}
