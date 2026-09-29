import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { GuideHubConfigError, loadConfig, type GuideHubConfig } from "../guidehub/config.js";
import { hashPassphrase, verifyPassphrase } from "../guidehub/password.js";
import { SessionStore } from "../guidehub/sessions.js";
import { LoginThrottle } from "../guidehub/throttle.js";
import { createGuideHubApp, CSRF_HEADER, CSRF_VALUE } from "../guidehub/server.js";
import { ALLOWED, matchRule } from "../guidehub/proxy.js";

process.env.NODE_ENV = "test";

const TOKEN = "aos_" + "T".repeat(43);
const PASS = "correct horse battery staple";
const UUID = "0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e";
const H = { [CSRF_HEADER]: CSRF_VALUE };

describe("guidehub config fails closed", () => {
  const good = { GUIDEHUB_API_TOKEN: TOKEN, GUIDEHUB_PASSWORD_HASH: "scrypt$1$1$1$a$b" };
  it("refuses to start without a token, with a non-Angel token, or without a scrypt hash", () => {
    expect(() => loadConfig({})).toThrow(GuideHubConfigError);
    expect(() => loadConfig({ ...good, GUIDEHUB_API_TOKEN: "hunter2" })).toThrow(/aos_/);
    expect(() => loadConfig({ ...good, GUIDEHUB_PASSWORD_HASH: "plaintext-password" })).toThrow(/scrypt/);
    expect(() => loadConfig({ ...good, GUIDEHUB_API_URL: "ftp://x" })).toThrow(/http/);
    expect(() => loadConfig({ ...good, GUIDEHUB_PUBLIC_ORIGIN: "https://x.example/path" })).toThrow(/origin/);
  });
  it("secure cookies are the default; only an explicit opt-out disables them", () => {
    expect(loadConfig(good).secureCookies).toBe(true);
    expect(loadConfig({ ...good, GUIDEHUB_INSECURE_COOKIES: "1" }).secureCookies).toBe(false);
    expect(loadConfig({ ...good, GUIDEHUB_INSECURE_COOKIES: "true" }).secureCookies).toBe(true);
    expect(loadConfig(good).apiBaseUrl).toBe("http://localhost:3000");
  });
});

describe("passphrase hashing", () => {
  it("verifies the right passphrase only; salts differ per hash; short passphrases are refused", async () => {
    const a = await hashPassphrase(PASS);
    const b = await hashPassphrase(PASS);
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassphrase(PASS, a)).toBe(true);
    expect(await verifyPassphrase(PASS + "x", a)).toBe(false);
    expect(await verifyPassphrase("", a)).toBe(false);
    await expect(hashPassphrase("short")).rejects.toThrow();
  });
  it("a malformed or hostile stored hash never verifies (and never throws)", async () => {
    for (const bad of ["", "x", "scrypt$", "scrypt$0$8$1$a$b", "scrypt$999999999$8$1$YQ==$YQ==", "scrypt$16384$8$1$YQ==$", "bcrypt$1$1$1$a$b", "scrypt$16384$8$1$YQ==$YQ=="]) expect(await verifyPassphrase(PASS, bad)).toBe(false);
  });
});

describe("sessions and throttle", () => {
  it("expire by age and by idle time, are revocable, and evict the oldest past the cap", () => {
    let t = 1_000;
    const s = new SessionStore({ maxAgeMs: 10_000, idleMs: 3_000, maxSessions: 2, now: () => t });
    const a = s.create();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.touch(a)).toBe(true);
    t += 2_000; expect(s.touch(a)).toBe(true); // refreshes idle
    t += 2_900; expect(s.touch(a)).toBe(true);
    t += 3_100; expect(s.touch(a)).toBe(false); // idle
    const b = s.create(); const c = s.create(); const d = s.create();
    expect(s.touch(b)).toBe(false); // evicted (cap 2)
    expect(s.touch(c) && s.touch(d)).toBe(true);
    s.destroy(c); expect(s.touch(c)).toBe(false);
    t += 20_000; expect(s.touch(d)).toBe(false); // absolute age
    expect(new Set([s.create(), s.create()]).size).toBe(2);
    expect(s.touch(undefined)).toBe(false);
    expect(s.touch("nope")).toBe(false);
  });
  it("limits sign-in attempts per client and globally; success clears the client, not the global window", () => {
    let t = 0;
    const th = new LoginThrottle({ perKeyMax: 3, globalMax: 5, windowMs: 60_000, now: () => t });
    for (let i = 0; i < 3; i++) th.recordFailure("1.1.1.1");
    expect(th.retryAfterSec("1.1.1.1")).toBeGreaterThan(0);
    expect(th.retryAfterSec("2.2.2.2")).toBe(0);
    th.recordSuccess("1.1.1.1");
    expect(th.retryAfterSec("1.1.1.1")).toBe(0);
    for (const k of ["a", "b", "c"]) th.recordFailure(k); // global: 3 + 3 = 6 ≥ 5
    expect(th.retryAfterSec("fresh-client")).toBeGreaterThan(0);
    t += 61_000;
    expect(th.retryAfterSec("fresh-client")).toBe(0);
  });
});

describe("guidehub server (BFF)", () => {
  let config: GuideHubConfig;
  const calls: { url: string; init: RequestInit }[] = [];
  let upstream: (url: string, init: RequestInit) => Promise<Response>;
  const okJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const build = (over: Partial<GuideHubConfig> = {}, now?: () => number) => {
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return upstream(url, init); }) as unknown as typeof fetch;
    return createGuideHubApp({ config: { ...config, ...over }, fetchImpl, now });
  };
  const login = async (app: ReturnType<typeof build>["app"]) => {
    const r = await request(app).post("/session").set(H).send({ passphrase: PASS });
    expect(r.status).toBe(200);
    return (r.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  };

  beforeAll(async () => {
    config = { port: 0, apiBaseUrl: "http://api.test", apiToken: TOKEN, passwordHash: await hashPassphrase(PASS), secureCookies: true, sessionMaxAgeMs: 3_600_000, sessionIdleMs: 600_000, trustProxy: false, upstreamTimeoutMs: 2_000 };
  });
  const reset = () => { calls.length = 0; upstream = async () => okJson({ ok: true }); };

  describe("sign-in and session", () => {
    it("wrong or missing passphrase → 401 with one generic message; no cookie", async () => {
      reset();
      const { app } = build();
      for (const body of [{ passphrase: "nope" }, {}, { passphrase: 5 }, { passphrase: "" }, { passphrase: "x".repeat(300) }]) {
        const r = await request(app).post("/session").set(H).send(body);
        expect(r.status, JSON.stringify(body)).toBe(401);
        expect(r.body).toEqual({ error: "Incorrect passphrase." });
        expect(r.headers["set-cookie"]).toBeUndefined();
      }
    });

    it("the session cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/ and has no Domain", async () => {
      reset();
      const { app } = build();
      const r = await request(app).post("/session").set(H).send({ passphrase: PASS });
      const cookie = (r.headers["set-cookie"] as unknown as string[])[0];
      expect(cookie).toMatch(/^__Host-guidehub=[A-Za-z0-9_-]{43};/);
      for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(cookie).toContain(attr);
      expect(cookie).not.toMatch(/Domain=/i);
      expect(JSON.stringify(r.body)).not.toContain(TOKEN);
    });

    it("plain-http development mode drops Secure and the __Host- prefix, and only then", async () => {
      reset();
      const { app } = build({ secureCookies: false });
      const r = await request(app).post("/session").set(H).send({ passphrase: PASS });
      const cookie = (r.headers["set-cookie"] as unknown as string[])[0];
      expect(cookie).toMatch(/^guidehub=/);
      expect(cookie).not.toContain("Secure");
      expect(cookie).toContain("HttpOnly");
    });

    it("a new id every sign-in (no fixation); logout invalidates the cookie server-side, not just in the browser", async () => {
      reset();
      const { app } = build();
      const one = await login(app);
      const two = await login(app);
      expect(one).not.toBe(two);
      expect((await request(app).get("/api/me").set("Cookie", one)).status).toBe(200);
      const relog = await request(app).post("/session").set(H).set("Cookie", one).send({ passphrase: PASS }); // sign in while holding an old id
      expect((relog.headers["set-cookie"] as unknown as string[])[0].split(";")[0]).not.toBe(one);
      expect((await request(app).get("/api/me").set("Cookie", one)).status).toBe(401); // the old id was destroyed
      expect((await request(app).delete("/session").set(H).set("Cookie", two)).status).toBe(200);
      expect((await request(app).get("/api/me").set("Cookie", two)).status).toBe(401); // replay of the stolen cookie fails
    });

    it("expires by idle time and absolute age", async () => {
      reset();
      let t = 1_000_000;
      const { app } = build({}, () => t);
      const c = await login(app);
      t += 500_000; expect((await request(app).get("/api/me").set("Cookie", c)).status).toBe(200);
      t += 700_000; expect((await request(app).get("/api/me").set("Cookie", c)).status).toBe(401); // idle > 10 min
      const d = await login(app);
      for (let i = 0; i < 8; i++) { t += 500_000; await request(app).get("/api/me").set("Cookie", d); }
      expect((await request(app).get("/api/me").set("Cookie", d)).status).toBe(401); // > 1 h absolute
    });

    it("GET /session reports state and the user's own profile from the API; it never errors for signed-out visitors", async () => {
      reset();
      upstream = async () => okJson({ principal: { id: "p", name: "Angel", timezone: "UTC" }, interface: "GUIDEHUB" });
      const { app } = build();
      expect((await request(app).get("/session")).body).toEqual({ authenticated: false });
      const c = await login(app);
      const r = await request(app).get("/session").set("Cookie", c);
      expect(r.body).toMatchObject({ authenticated: true, me: { principal: { name: "Angel" } } });
      upstream = async () => { throw new Error("down"); };
      expect((await request(app).get("/session").set("Cookie", c)).body).toEqual({ authenticated: true, me: null });
    });

    it("sign-in attempts are throttled (429 + Retry-After) even for the right passphrase, per client", async () => {
      reset();
      const { app } = build();
      for (let i = 0; i < 5; i++) await request(app).post("/session").set(H).send({ passphrase: "wrong" });
      const blocked = await request(app).post("/session").set(H).send({ passphrase: PASS });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(blocked.headers["set-cookie"]).toBeUndefined();
    });
  });

  describe("CSRF and origin", () => {
    it("every state-changing request needs the custom header; a foreign Origin is refused even with it", async () => {
      reset();
      const { app } = build();
      const c = await login(app);
      expect((await request(app).post("/session").send({ passphrase: PASS })).status).toBe(403);
      expect((await request(app).delete("/session").set("Cookie", c)).status).toBe(403);
      expect((await request(app).post("/api/jarvis").set("Cookie", c).send({ input: "hi" })).status).toBe(403);
      expect((await request(app).post("/session").set(H).set("Origin", "https://evil.example").send({ passphrase: PASS })).status).toBe(403);
      expect((await request(app).post("/api/jarvis").set(H).set("Cookie", c).set("Origin", "https://evil.example").send({ input: "hi" })).status).toBe(403);
      expect(calls).toHaveLength(0);
    });
    it("a configured public origin is the only accepted Origin", async () => {
      reset();
      const { app } = build({ publicOrigin: "https://cockpit.example.com" });
      expect((await request(app).post("/session").set(H).set("Origin", "https://cockpit.example.com").send({ passphrase: PASS })).status).toBe(200);
      expect((await request(app).post("/session").set(H).set("Origin", "https://other.example.com").send({ passphrase: PASS })).status).toBe(403);
    });
  });

  describe("the proxy: default deny, server-side credentials", () => {
    it("without a session nothing reaches the API", async () => {
      reset();
      const { app } = build();
      for (const [m, p] of [["get", "/api/me"], ["get", "/api/context"], ["post", "/api/jarvis"], ["get", "/api/audit"]] as const) {
        const r = await (request(app) as any)[m](p).set(H).send({});
        expect(r.status, p).toBe(401);
      }
      expect(calls).toHaveLength(0);
    });

    it("an allowed route is forwarded with the SERVER's token; the browser's cookie and Authorization header are never forwarded", async () => {
      reset();
      const { app } = build();
      const c = await login(app);
      const r = await request(app).get("/api/context?q=tea").set("Cookie", c).set("Authorization", "Bearer aos_browser-supplied-should-be-ignored").set("X-Principal-Id", "someone-else");
      expect(r.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://api.test/api/context?q=tea");
      const sent = calls[0].init.headers as Record<string, string>;
      expect(sent.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(Object.keys(sent).map((k) => k.toLowerCase()).sort()).toEqual(["accept", "authorization"]);
      expect(JSON.stringify(sent)).not.toContain("browser-supplied");
      expect(JSON.stringify(sent)).not.toContain("guidehub=");
    });

    it("only the allow-listed method+path pairs pass; everything else is 404 at the cockpit and never reaches the API", async () => {
      reset();
      const { app } = build();
      const c = await login(app);
      const blocked: [string, string][] = [
        ["get", "/api/audit"], ["get", "/api/tasks"], ["get", "/api/actions"], ["get", "/api/knowledge/search"], ["get", "/api/connections"], ["get", "/api/reviews"], ["get", "/api/results"], ["get", "/api/future/aspirations"],
        ["post", "/api/knowledge/ingest"], ["post", "/api/reminders"], ["post", "/api/tasks"],
        ["post", "/api/actions/system.memory/MEMORY_DELETE"], ["post", "/api/actions/system.life/RESULT_RECORD"], ["post", "/api/actions/system.life/REVIEW_CREATE"], ["post", "/api/actions/system.life/VISION_UPDATE"], ["post", "/api/actions/system.life/QUEST_UPDATE"],
        ["post", "/api/actions/system.life/PROJECT_LINK_KNOWLEDGE"], ["post", "/api/actions/system.tasks/TASK_UPDATE"], ["post", "/api/actions/system.tasks/CREATE_REMINDER"], ["post", "/api/actions/system.decisions/DECISION_RECORD"], ["post", "/api/actions/system.future/ASPIRATION_ACHIEVE"], ["post", "/api/actions/system.learning/TOPIC_CREATE"], ["post", "/api/actions/system.knowledge/KNOWLEDGE_DELETE_SOURCE"],
        ["post", "/api/actions/system.life/GOAL_CREATE/extra"], ["post", "/api/actions/system.lifeX/GOAL_CREATE"], ["post", "/api/actions/systemXlife/GOAL_CREATE"], ["post", "/api/actions/system.life/GOAL_CREATE2"], ["post", "/api/actions/system.life/xGOAL_CREATE"],
        ["post", "/api/context"], ["get", "/api/jarvis"], ["delete", "/api/approvals"], ["put", "/api/jarvis"], ["patch", "/api/decisions"], ["delete", "/api/life/overview"], ["post", "/api/life/overview"], ["get", "/api/life/projects/not-a-uuid"], ["get", "/api/life/other"],
        ["get", `/api/approvals/${UUID}/approve`], ["post", "/api/approvals/not-a-uuid/approve"], ["post", `/api/approvals/${UUID}/approve/extra`],
        ["get", "/api/me/../audit"], ["get", "/api/me%2f..%2faudit"], ["get", "/api/integrations/google/calendar/connect"],
      ];
      for (const [m, p] of blocked) {
        const r = await (request(app) as any)[m](p).set(H).set("Cookie", c).send(m === "get" ? undefined : { a: 1 });
        expect([404, 400], `${m} ${p}`).toContain(r.status);
      }
      expect(calls).toHaveLength(0);
      expect(ALLOWED.every((r) => r.method === "GET" || r.method === "POST")).toBe(true);
      expect(matchRule("DELETE", "/api/me")).toBeUndefined();
    });

    it("every step-1 and step-2 route the screens use IS allowed, exactly as listed — and nothing more", () => {
      const allowed: [string, string][] = [
        ["GET", "/api/me"], ["GET", "/api/context"], ["GET", "/api/approvals"], ["GET", `/api/approvals/${UUID}`], ["POST", `/api/approvals/${UUID}/approve`], ["POST", `/api/approvals/${UUID}/deny`], ["POST", "/api/jarvis"], ["GET", "/api/decisions"], ["GET", "/api/learning/due"],
        ["POST", "/api/actions/system.decisions/DECISION_REVIEW"], ["POST", "/api/actions/system.learning/CARD_REVIEW"],
        ["GET", "/api/life/overview"], ["GET", "/api/life/history"], ["GET", "/api/life/people"], ["GET", `/api/life/projects/${UUID}`],
        ...["VISION_CREATE", "VISION_ARCHIVE", "GOAL_CREATE", "GOAL_UPDATE", "GOAL_ACHIEVE", "GOAL_ABANDON", "PROJECT_CREATE", "PROJECT_UPDATE", "PROJECT_SET_STATUS", "PROJECT_LINK_PERSON", "PROJECT_UNLINK_PERSON", "QUEST_CREATE", "QUEST_START", "QUEST_COMPLETE", "QUEST_ABANDON", "PERSON_CREATE", "PERSON_UPDATE", "PERSON_DELETE"].map((a) => ["POST", `/api/actions/system.life/${a}`] as [string, string]),
        ...["CREATE_TASK", "TASK_COMPLETE", "TASK_CANCEL"].map((a) => ["POST", `/api/actions/system.tasks/${a}`] as [string, string]),
      ];
      for (const [m, p] of allowed) expect(matchRule(m, p), `${m} ${p}`).toBeDefined();
      expect(ALLOWED).toHaveLength(14); // a new rule entry must come with a new line in this test
    });

    it("approve/deny take NO parameters: a body with anything is refused before it reaches the API; the API always receives {}", async () => {
      reset();
      const { app } = build();
      const c = await login(app);
      const bad = await request(app).post(`/api/approvals/${UUID}/approve`).set(H).set("Cookie", c).send({ personId: "swap" });
      expect(bad.status).toBe(400);
      expect(calls).toHaveLength(0);
      expect((await request(app).post(`/api/approvals/${UUID}/deny`).set(H).set("Cookie", c).send({})).status).toBe(200);
      expect(calls[0].init.body).toBe("{}");
    });

    it("POST bodies must be JSON; queries are forwarded for GET only and are length-bounded", async () => {
      reset();
      const { app } = build();
      const c = await login(app);
      expect((await request(app).post("/api/jarvis").set(H).set("Cookie", c).set("Content-Type", "text/plain").send("hello")).status).toBe(415);
      await request(app).post("/api/jarvis?principalId=x").set(H).set("Cookie", c).send({ input: "hi" });
      expect(calls[0].url).toBe("http://api.test/api/jarvis"); // the query string was not forwarded on POST
      expect((await request(app).get(`/api/context?q=${"x".repeat(1200)}`).set("Cookie", c)).status).toBe(400);
    });

    it("upstream statuses pass through unchanged (202/403/404/422), bodies untouched", async () => {
      const { app } = build();
      const c = await login(app);
      for (const [status, body] of [[202, { status: "PENDING_APPROVAL", approvalId: UUID }], [403, { status: "DENIED" }], [404, { status: "FAILED", message: "That task wasn't found." }], [422, { status: "FAILED", message: "bad" }]] as const) {
        upstream = async () => okJson(body, status);
        const r = await request(app).post("/api/actions/system.tasks/TASK_COMPLETE").set(H).set("Cookie", c).send({ taskId: UUID });
        expect(r.status).toBe(status);
        expect(r.body).toEqual(body);
      }
    });

    it("a rejected cockpit token is a server problem (502), never a sign-in prompt, and the token is never echoed", async () => {
      const { app } = build();
      const c = await login(app);
      upstream = async () => okJson({ error: "Unauthorized." }, 401);
      const r = await request(app).get("/api/me").set("Cookie", c);
      expect(r.status).toBe(502);
      expect(JSON.stringify(r.body) + JSON.stringify(r.headers)).not.toContain(TOKEN);
    });

    it("an unreachable, slow or non-JSON API is 502 with no detail", async () => {
      const { app } = build();
      const c = await login(app);
      for (const impl of [async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:3000 secret"); }, async () => new Response("<html>oops</html>", { status: 200 }), async () => new Response("", { status: 500 })]) {
        upstream = impl as never;
        const r = await request(app).get("/api/me").set("Cookie", c);
        expect(r.status).toBe(502);
        expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|html|secret/);
      }
    });

    it("the API token appears in no response body or header, ever", async () => {
      reset();
      const { app } = build();
      const c = await login(app);
      const seen: string[] = [];
      for (const p of ["/", "/app.js", "/lib.js", "/styles.css", "/healthz", "/session", "/api/me", "/nope"]) {
        const r = await request(app).get(p).set("Cookie", c);
        seen.push(JSON.stringify(r.headers), r.text ?? "");
      }
      expect(seen.join("\n")).not.toContain(TOKEN);
      expect(seen.join("\n")).not.toContain("aos_");
    });
  });

  describe("headers and static files", () => {
    it("every response carries the security headers; API responses are never cached", async () => {
      reset();
      const { app } = build();
      const c = await login(app);
      for (const p of ["/", "/healthz", "/session", "/api/me", "/nope"]) {
        const r = await request(app).get(p).set("Cookie", c);
        expect(r.headers["content-security-policy"], p).toContain("script-src 'self'");
        expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
        expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(r.headers["x-frame-options"]).toBe("DENY");
        expect(r.headers["x-content-type-options"]).toBe("nosniff");
        expect(r.headers["referrer-policy"]).toBe("no-referrer");
        expect(r.headers["x-powered-by"]).toBeUndefined();
      }
      for (const p of ["/session", "/api/me"]) expect((await request(app).get(p).set("Cookie", c)).headers["cache-control"]).toBe("no-store");
    });

    it("serves the app shell without a session, refuses dotfiles and traversal, and 404s unknown paths as JSON", async () => {
      reset();
      const { app } = build();
      expect((await request(app).get("/")).status).toBe(200);
      expect((await request(app).get("/app.js")).headers["content-type"]).toMatch(/javascript/);
      for (const p of ["/.env", "/../config.ts", "/%2e%2e/config.ts", "/server.ts", "/password.ts", "/..%2fpackage.json"]) expect((await request(app).get(p)).status, p).toBe(404);
      expect((await request(app).get("/nope")).body).toEqual({ error: "Not found." });
    });

    it("dotfiles in the public directory are never served (a stray .env or .git file would be a leak)", async () => {
      reset();
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const probe = new URL("../guidehub/public/.probe-secret", import.meta.url);
      writeFileSync(probe, "TOP-SECRET-PROBE");
      try {
        const { app } = build();
        const r = await request(app).get("/.probe-secret");
        expect(r.status).toBe(404);
        expect(r.text).not.toContain("TOP-SECRET-PROBE");
      } finally { unlinkSync(probe); }
    });

    it("an oversized body is 413 with a plain message", async () => {
      reset();
      const { app } = build();
      const r = await request(app).post("/session").set(H).send({ passphrase: "x".repeat(100_000) });
      expect(r.status).toBe(413);
      expect(r.body).toEqual({ error: "Request too large." });
    });
  });
});
