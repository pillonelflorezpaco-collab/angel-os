import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getDb, disconnectDb } from "../db/client/index.js";
import { setClock } from "../gateway/clock.js";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import { registerSkillActions, PRODUCTION_DEFINITIONS } from "../skills/manifest.js";
import { proposeLearning, readLearningOverview, readDueCards, readCard } from "../skills/system/learning.js";
import { DeterministicContextEngine } from "../context/retrieval/index.js";
import { formatContext } from "../context/format.js";
import { createPrincipal, deletePrincipal, grant } from "./helpers/fixtures.js";
import { identityFor } from "./helpers/fakeActions.js";

process.env.NODE_ENV = "test";
registerSkillActions();
const readA = { agentKey: JARVIS_AGENT_KEY };
const DAY = 24 * 3600 * 1000;

describe("Learning Lab: topics, sessions, recall cards", () => {
  let a: string;
  let b: string;
  const db = () => getDb();
  const idA = (s: "GUIDEHUB" | "VOICE" | "TELEGRAM" | "API" = "GUIDEHUB") => identityFor(a, s);
  const idB = () => identityFor(b, "GUIDEHUB");
  type Who = ReturnType<typeof idA>;
  const ok = async (who: Who, action: string, params: unknown) => {
    const r = await proposeLearning(who, action, params);
    expect(r.status, `${action}: ${JSON.stringify(r)}`).toBe("EXECUTED");
    return r.data as any;
  };
  const failed = async (who: Who, action: string, params: unknown) => {
    const r = await proposeLearning(who, action, params);
    expect(r.status, `${action} ${JSON.stringify(params)}: ${JSON.stringify(r)}`).toBe("FAILED");
    return r;
  };
  const topic = (extra: Record<string, unknown> = {}, who: Who = idA()) => ok(who, "TOPIC_CREATE", { title: `topic-${Math.random()}`, ...extra });
  const card = (topicId: string, who: Who = idA(), extra: Record<string, unknown> = {}) => ok(who, "CARD_CREATE", { topicId, prompt: `q-${Math.random()}`, answer: "a", ...extra });

  beforeAll(async () => {
    a = (await createPrincipal("Learning A")).id;
    b = (await createPrincipal("Learning B")).id;
    for (const p of [a, b]) {
      await grant(p, JARVIS_AGENT_KEY, "system.learning", "angel:learning", "LEARNING_READ", "READ");
      for (const d of PRODUCTION_DEFINITIONS.filter((x) => x.skillKey === "system.learning" && x.category === "WRITE")) await grant(p, JARVIS_AGENT_KEY, d.skillKey, d.resource, d.action, "WRITE");
    }
  });
  afterAll(async () => { await deletePrincipal(a); await deletePrincipal(b); await disconnectDb(); });
  beforeEach(() => setClock(null));
  afterEach(() => setClock(null));

  describe("topics", () => {
    it("lifecycle: pause/resume; COMPLETED is the owner's claim and is final", async () => {
      const t = await topic({ area: "maths", intent: "to teach my kid" });
      expect(t).toMatchObject({ principalId: a, status: "ACTIVE", area: "maths" });
      await ok(idA(), "TOPIC_SET_STATUS", { topicId: t.id, status: "PAUSED" });
      await failed(idA(), "TOPIC_SET_STATUS", { topicId: t.id, status: "PAUSED" });
      await ok(idA(), "TOPIC_SET_STATUS", { topicId: t.id, status: "ACTIVE" });
      await ok(idA(), "TOPIC_UPDATE", { topicId: t.id, intent: null });
      await ok(idA(), "TOPIC_SET_STATUS", { topicId: t.id, status: "COMPLETED" });
      const row = await db().learningTopic.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.completedAt).toBeInstanceOf(Date);
      await failed(idA(), "TOPIC_SET_STATUS", { topicId: t.id, status: "ACTIVE" });
      await failed(idA(), "TOPIC_SET_STATUS", { topicId: t.id, status: "COMPLETED" }); // no second completion
      expect((await db().learningTopic.findUniqueOrThrow({ where: { id: t.id } })).completedAt).toEqual(row.completedAt);
      await failed(idA(), "TOPIC_UPDATE", { topicId: t.id, title: "edit" });
      await expect(db().learningTopic.update({ where: { id: t.id }, data: { status: "ACTIVE", completedAt: null } })).rejects.toThrow();
    });

    it("a goal link must be the owner's (skill and database)", async () => {
      const foreign = await db().goal.create({ data: { principalId: b, title: "B goal" } });
      expect((await failed(idA(), "TOPIC_CREATE", { title: "x", goalId: foreign.id })).message).toMatch(/wasn't found/);
      await expect(db().learningTopic.create({ data: { principalId: a, title: "x", goalId: foreign.id } })).rejects.toThrow(/cross-principal/);
    });
  });

  describe("sessions: self-reported, append-only, no rewards", () => {
    it("log minutes with an optional owned knowledge item; Activity references the session and copies no note", async () => {
      const t = await topic();
      const src = await db().knowledgeSource.create({ data: { principalId: a, title: "s", kind: "note", contentHash: `h-${Math.random()}` } });
      const item = await db().knowledgeItem.create({ data: { principalId: a, sourceId: src.id, kind: "FACT", title: "Fact", body: "b", origin: "INGESTED" } as never });
      const s = await ok(idA(), "SESSION_LOG", { topicId: t.id, minutes: 45, note: "secret-ish note zzqq", knowledgeItemId: item.id });
      expect(s).toMatchObject({ minutes: 45, principalId: a });
      const acts = await db().activity.findMany({ where: { principalId: a, refId: s.id } });
      expect(acts).toHaveLength(1);
      expect(acts[0]).toMatchObject({ type: "LEARNING_SESSION", refType: "learning_session" });
      expect(JSON.stringify(acts[0])).not.toContain("zzqq");
      await expect(db().learningSession.update({ where: { id: s.id }, data: { minutes: 999 } })).rejects.toThrow(/append-only/);
    });

    it("bounds: 1–720 whole minutes, not in the future, only on ACTIVE topics", async () => {
      const t = await topic();
      for (const minutes of [0, -5, 721, 1.5]) await failed(idA(), "SESSION_LOG", { topicId: t.id, minutes });
      await failed(idA(), "SESSION_LOG", { topicId: t.id, minutes: 30, studiedAt: new Date(Date.now() + DAY).toISOString() });
      await ok(idA(), "SESSION_LOG", { topicId: t.id, minutes: 30, studiedAt: new Date(Date.now() - DAY).toISOString() });
      await ok(idA(), "TOPIC_SET_STATUS", { topicId: t.id, status: "PAUSED" });
      expect((await failed(idA(), "SESSION_LOG", { topicId: t.id, minutes: 10 })).message).toMatch(/isn't active/);
      await expect(db().learningSession.create({ data: { principalId: a, topicId: t.id, minutes: 5000, studiedAt: new Date() } })).rejects.toThrow();
    });

    it("someone else's topic or knowledge item is 'not found'", async () => {
      const tB = await topic({}, idB());
      expect((await failed(idA(), "SESSION_LOG", { topicId: tB.id, minutes: 10 })).message).toMatch(/wasn't found/);
      const tA = await topic();
      const srcB = await db().knowledgeSource.create({ data: { principalId: b, title: "s", kind: "note", contentHash: `h-${Math.random()}` } });
      const itemB = await db().knowledgeItem.create({ data: { principalId: b, sourceId: srcB.id, kind: "FACT", title: "B", body: "b", origin: "INGESTED" } as never });
      expect((await failed(idA(), "SESSION_LOG", { topicId: tA.id, minutes: 10, knowledgeItemId: itemB.id })).message).toMatch(/wasn't found/);
      await expect(db().learningSession.create({ data: { principalId: a, topicId: tA.id, minutes: 10, studiedAt: new Date(), knowledgeItemId: itemB.id } })).rejects.toThrow(/cross-principal/);
    });

    it("the overview reports plain self-reported minutes (7 and 30 days) and no score, streak or XP", async () => {
      const c = (await createPrincipal("Learning overview")).id;
      try {
        for (const act of ["TOPIC_CREATE", "SESSION_LOG"]) await grant(c, JARVIS_AGENT_KEY, "system.learning", "angel:learning", act, "WRITE");
        await grant(c, JARVIS_AGENT_KEY, "system.learning", "angel:learning", "LEARNING_READ", "READ");
        const who = identityFor(c, "GUIDEHUB");
        const t = await topic({ title: "Overview topic" }, who);
        for (const [m, d] of [[30, 1], [20, 3], [50, 10], [40, 45]] as const) await ok(who, "SESSION_LOG", { topicId: t.id, minutes: m, studiedAt: new Date(Date.now() - d * DAY).toISOString() });
        const [o] = (await readLearningOverview(who, readA)).data as any[];
        expect(o).toMatchObject({ title: "Overview topic", minutesLast7Days: 50, minutesLast30Days: 100, cards: 0, due: 0 });
        for (const k of ["score", "streak", "xp", "level", "mastery", "mastered"]) expect(Object.keys(o)).not.toContain(k);
      } finally { await deletePrincipal(c); }
    });
  });

  describe("cards and reviews", () => {
    it("a new card is due at once; reviewing schedules the next due date from the injected history; the answer is owner-written", async () => {
      const t = await topic();
      const c = await card(t.id);
      expect(((await readDueCards(idA(), { ...readA, topicId: t.id })).data as any[]).map((x) => x.id)).toEqual([c.id]);
      const t0 = new Date(Date.now() - 10 * DAY);
      await ok(idA(), "CARD_REVIEW", { cardId: c.id, grade: 2, reviewedAt: t0.toISOString() });
      const after1 = (await readCard(idA(), { ...readA, cardId: c.id })).data as any;
      expect(after1).toMatchObject({ reviews: 1, intervalDays: 1, streak: 1, due: true });
      const t1 = new Date(Date.now() - 5 * DAY);
      await ok(idA(), "CARD_REVIEW", { cardId: c.id, grade: 2, reviewedAt: t1.toISOString() });
      const after2 = (await readCard(idA(), { ...readA, cardId: c.id })).data as any;
      expect(after2).toMatchObject({ intervalDays: 3, due: true });
      expect(new Date(after2.dueAt).getTime()).toBe(t1.getTime() + 3 * DAY);
      await ok(idA(), "CARD_REVIEW", { cardId: c.id, grade: 2, reviewedAt: new Date(Date.now() - 1000).toISOString() });
      const after3 = (await readCard(idA(), { ...readA, cardId: c.id })).data as any;
      expect(after3).toMatchObject({ intervalDays: 8, due: false });
      expect(((await readDueCards(idA(), { ...readA, topicId: t.id })).data as any[]).map((x) => x.id)).not.toContain(c.id);
      // the injected clock decides what is due
      const later = new Date(Date.now() + 9 * DAY);
      expect(((await readDueCards(idA(), { ...readA, topicId: t.id, now: later })).data as any[]).map((x) => x.id)).toContain(c.id);
    });

    it("a lapse is remembered and reschedules to 1 day; reviews are append-only and cannot be edited or deleted-and-replayed via the API", async () => {
      const t = await topic();
      const c = await card(t.id);
      for (const [i, grade] of [2, 2, 0].entries()) await ok(idA(), "CARD_REVIEW", { cardId: c.id, grade, reviewedAt: new Date(Date.now() - (3 - i) * 60_000).toISOString() });
      expect(((await readCard(idA(), { ...readA, cardId: c.id })).data as any)).toMatchObject({ lapses: 1, intervalDays: 1, streak: 0, reviews: 3 });
      const r = await db().cardReview.findFirstOrThrow({ where: { cardId: c.id } });
      await expect(db().cardReview.update({ where: { id: r.id }, data: { grade: 3 } })).rejects.toThrow(/append-only/);
    });

    it("grades are 0..3 only; reviews cannot be from the future; retired cards take no reviews and never come back", async () => {
      const t = await topic();
      const c = await card(t.id);
      for (const grade of [-1, 4, 2.5, "2", null]) await failed(idA(), "CARD_REVIEW", { cardId: c.id, grade });
      await failed(idA(), "CARD_REVIEW", { cardId: c.id, grade: 2, reviewedAt: new Date(Date.now() + DAY).toISOString() });
      await expect(db().cardReview.create({ data: { principalId: a, cardId: c.id, grade: 9, reviewedAt: new Date() } })).rejects.toThrow();
      await ok(idA(), "CARD_RETIRE", { cardId: c.id });
      await failed(idA(), "CARD_RETIRE", { cardId: c.id });
      expect((await failed(idA(), "CARD_REVIEW", { cardId: c.id, grade: 2 })).message).toMatch(/retired/);
      expect(((await readDueCards(idA(), { ...readA, topicId: t.id })).data as any[]).map((x) => x.id)).not.toContain(c.id);
      await expect(db().learningCard.update({ where: { id: c.id }, data: { status: "ACTIVE" } })).rejects.toThrow();
    });

    it("cards can only be added to ACTIVE topics; paused/completed topics' cards are not due", async () => {
      const t = await topic();
      const c = await card(t.id);
      await ok(idA(), "TOPIC_SET_STATUS", { topicId: t.id, status: "PAUSED" });
      expect((await failed(idA(), "CARD_CREATE", { topicId: t.id, prompt: "p", answer: "a" })).message).toMatch(/isn't active/);
      expect(((await readDueCards(idA(), readA)).data as any[]).map((x) => x.id)).not.toContain(c.id);
    });

    it("racing identical reviews each append one row (history is honest), and racing retires have exactly one winner", async () => {
      const t = await topic();
      const c = await card(t.id);
      const rs = await Promise.all(Array.from({ length: 5 }, () => proposeLearning(idA(), "CARD_RETIRE", { cardId: c.id })));
      expect(rs.filter((r) => r.status === "EXECUTED")).toHaveLength(1);
      const c2 = await card(t.id);
      await Promise.all(Array.from({ length: 4 }, (_, i) => proposeLearning(idA(), "CARD_REVIEW", { cardId: c2.id, grade: 2, reviewedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString() })));
      expect(await db().cardReview.count({ where: { cardId: c2.id } })).toBe(4);
    });
  });

  describe("isolation and policy", () => {
    it("another principal cannot see, review, retire or list anything, and the DB refuses foreign references", async () => {
      const t = await topic({ title: "PrivateTopicXyz" });
      const c = await card(t.id);
      expect(JSON.stringify((await readLearningOverview(idB(), readA)).data)).not.toContain("PrivateTopicXyz");
      expect(JSON.stringify((await readDueCards(idB(), readA)).data)).not.toContain(c.id);
      expect((await readCard(idB(), { ...readA, cardId: c.id })).status).toBe("FAILED");
      for (const [action, params] of [
        ["CARD_REVIEW", { cardId: c.id, grade: 2 }], ["CARD_RETIRE", { cardId: c.id }], ["CARD_CREATE", { topicId: t.id, prompt: "p", answer: "a" }],
        ["TOPIC_UPDATE", { topicId: t.id, title: "x" }], ["TOPIC_SET_STATUS", { topicId: t.id, status: "COMPLETED" }],
      ] as const) expect((await failed(idB(), action, params)).message, action).toMatch(/wasn't found/);
      await expect(db().cardReview.create({ data: { principalId: b, cardId: c.id, grade: 2, reviewedAt: new Date() } })).rejects.toThrow(/cross-principal/);
      await expect(db().learningCard.create({ data: { principalId: b, topicId: t.id, prompt: "p", answer: "a" } })).rejects.toThrow(/cross-principal/);
      expect(await db().cardReview.count({ where: { cardId: c.id } })).toBe(0);
    });

    it("LOW writes are direct on GuideHub/Telegram/API and need approval by voice; strict schemas refuse extras", async () => {
      for (const s of ["GUIDEHUB", "TELEGRAM", "API"] as const) await ok(idA(s), "TOPIC_CREATE", { title: `via ${s}` });
      const title = `voice-${Math.random()}`;
      expect((await proposeLearning(idA("VOICE"), "TOPIC_CREATE", { title })).status).toBe("PENDING_APPROVAL");
      expect(await db().learningTopic.count({ where: { principalId: a, title } })).toBe(0);
      const t = await topic();
      const c = await card(t.id);
      const before = await db().approvalRequest.count({ where: { principalId: a } });
      for (const [action, params] of [
        ["TOPIC_CREATE", { title: "x", principalId: b }], ["TOPIC_CREATE", { title: "x", status: "COMPLETED" }],
        ["SESSION_LOG", { topicId: t.id, minutes: 10, xp: 5 }], ["CARD_REVIEW", { cardId: c.id, grade: 2, dueAt: new Date().toISOString() }],
        ["CARD_REVIEW", { cardId: c.id, grade: 2, interval: 30 }], ["CARD_CREATE", { topicId: t.id, prompt: "p", answer: "a", status: "RETIRED" }],
        ["TOPIC_UPDATE", { topicId: t.id }], ["TOPIC_CREATE", { title: "x", area: "Not A Slug" }],
      ] as const) expect((await proposeLearning(idA(), action, params)).status, action + JSON.stringify(params)).toBe("FAILED");
      expect(await db().approvalRequest.count({ where: { principalId: a } })).toBe(before);
    });

    it("no grant → denied, nothing created; DENIED beats a grant", async () => {
      const c = (await createPrincipal("Learning none")).id;
      try {
        expect((await proposeLearning(identityFor(c), "TOPIC_CREATE", { title: "x" })).status).toBe("DENIED");
        expect((await readLearningOverview(identityFor(c), readA)).status).toBe("DENIED");
        await grant(c, JARVIS_AGENT_KEY, "system.learning", "angel:learning", "TOPIC_CREATE", "WRITE", "DENIED");
        expect((await proposeLearning(identityFor(c), "TOPIC_CREATE", { title: "x" })).status).toBe("DENIED");
        expect(await db().learningTopic.count({ where: { principalId: c } })).toBe(0);
      } finally { await deletePrincipal(c); }
    });
  });

  it("the Context Engine shows active topics with plain counts, withholds without LEARNING_READ, and shows nothing of another principal", async () => {
    const c = (await createPrincipal("Learning ctx")).id;
    const d = (await createPrincipal("Learning ctx none")).id;
    try {
      await grant(c, JARVIS_AGENT_KEY, "system.learning", "angel:learning", "LEARNING_READ", "READ");
      await db().learningTopic.create({ data: { principalId: c, title: "qzvk topic" } });
      await db().learningTopic.create({ data: { principalId: b, title: "qzvk someone else" } });
      const engine = new DeterministicContextEngine();
      const ctx = await engine.buildContext({ identity: identityFor(c), agentKey: JARVIS_AGENT_KEY, query: "qzvk" });
      expect(ctx.activeLearning).toEqual([expect.objectContaining({ title: "qzvk topic", minutesLast7Days: 0, cards: 0, due: 0 })]);
      expect(formatContext(ctx)).toContain("self-reported");
      const none = await engine.buildContext({ identity: identityFor(d), agentKey: JARVIS_AGENT_KEY, query: "qzvk" });
      expect(none.withheld).toContain("learning");
      expect(none.activeLearning).toEqual([]);
    } finally { await deletePrincipal(c); await deletePrincipal(d); }
  });
});
