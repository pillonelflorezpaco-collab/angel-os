import express from "express";
import { z } from "zod";
import { JARVIS_AGENT_KEY } from "../core/index.js";
import type { Result } from "../core/types/index.js";
import { isKnownAction, listActionCatalog, proposeNamedAction } from "../skills/system/apiActions.js";
import { readLifeOverview, readLifeHistory, readProject, readPeople, readResults, readReviews } from "../skills/system/life.js";
import { readDecision, listDecisionRecords } from "../skills/system/decisions.js";
import { readFutureOverview, readAspiration, readStateTimeline } from "../skills/system/future.js";
import { readLearningOverview, readDueCards, readCard, readObjectives, readSessions, readExperiments, readExperiment } from "../skills/system/learning.js";
import { readOpenLoops, readBadges } from "../skills/system/today.js";
import { readRoutines, readTodayPlan } from "../skills/system/routines.js";
import { asyncRoute, identityOf } from "./middleware.js";

// GuideHub-ready surface for the Life OS domains (BUILD #18). Still an ADAPTER: identity comes from the
// authenticated token (never the request), reads go Skill → READ lane, and every write is
//     POST /api/actions/:skillKey/:action   { …exact action parameters… }
// which proposes the registered ActionDefinition — permission, interface policy, approval and audit apply
// exactly as for any other caller. There are deliberately no per-entity write routes to drift out of sync.
//
// Status mapping (new routes only): EXECUTED 200 · PENDING_APPROVAL 202 (decide via /api/approvals/:id/approve|deny)
// · DENIED 403 · FAILED 404 when the target wasn't found (missing and foreign are indistinguishable) else 422.

export function statusFor(result: Result): number {
  switch (result.status) {
    case "EXECUTED": return 200;
    case "PENDING_APPROVAL": return 202;
    case "DENIED": return 403;
    default: return /wasn't found/i.test(result.message) ? 404 : 422;
  }
}

const uuid = z.string().uuid();
const respond = (res: express.Response, result: Result) => res.status(statusFor(result)).json(result);
const agentKey = JARVIS_AGENT_KEY;
const badId = (res: express.Response) => res.status(400).json({ error: "Invalid id." });

export function lifeRouter(): express.Router {
  const r = express.Router();

  // What can be done. Names, categories, risk and top-level field names — enough to build forms.
  // Having an entry grants nothing: each call is still permission-checked, policy-checked and audited.
  r.get("/actions", (_req, res) => {
    res.json(listActionCatalog());
  });

  r.post(
    "/actions/:skillKey/:action",
    asyncRoute(async (req, res) => {
      const { skillKey, action } = req.params;
      if (!isKnownAction(skillKey, action)) return res.status(404).json({ error: "Unknown action." });
      const body = req.body ?? {};
      if (typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "The body must be a JSON object of action parameters." });
      respond(res, await proposeNamedAction(identityOf(req), skillKey, action, body));
    })
  );

  // ── Life OS structure ────────────────────────────────────────────────────
  r.get("/life/overview", asyncRoute(async (req, res) => respond(res, await readLifeOverview(identityOf(req), { agentKey }))));
  r.get("/life/history", asyncRoute(async (req, res) => respond(res, await readLifeHistory(identityOf(req), { agentKey }))));
  r.get("/life/people", asyncRoute(async (req, res) => respond(res, await readPeople(identityOf(req), { agentKey }))));
  r.get("/life/projects/:id", asyncRoute(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return badId(res);
    respond(res, await readProject(identityOf(req), { agentKey, projectId: req.params.id }));
  }));

  // ── Decisions, results, reviews ─────────────────────────────────────────
  r.get("/decisions", asyncRoute(async (req, res) => {
    const q = z.object({ dueForReview: z.enum(["true", "false"]).optional() }).strict().safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: q.error.flatten() });
    respond(res, await listDecisionRecords(identityOf(req), { agentKey, dueForReview: q.data.dueForReview === "true" }));
  }));
  r.get("/decisions/:id", asyncRoute(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return badId(res);
    respond(res, await readDecision(identityOf(req), { agentKey, decisionId: req.params.id }));
  }));
  r.get("/results", asyncRoute(async (req, res) => {
    const q = z.object({ subjectKind: z.enum(["GOAL", "PROJECT", "QUEST", "DECISION"]).optional(), subjectId: uuid.optional() }).strict()
      .refine((v) => (v.subjectKind === undefined) === (v.subjectId === undefined), { message: "subjectKind and subjectId go together" }).safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: q.error.flatten() });
    respond(res, await readResults(identityOf(req), { agentKey, ...q.data }));
  }));
  r.get("/reviews", asyncRoute(async (req, res) => respond(res, await readReviews(identityOf(req), { agentKey }))));

  // ── What matters + factual badges (read-only) ──────────────────────────
  r.get("/today/loops", asyncRoute(async (req, res) => respond(res, await readOpenLoops(identityOf(req)))));
  r.get("/progress/badges", asyncRoute(async (req, res) => respond(res, await readBadges(identityOf(req)))));

  // ── Routines (reads; writes are actions on system.routines) ─────────────
  r.get("/routines", asyncRoute(async (req, res) => respond(res, await readRoutines(identityOf(req), { agentKey }))));
  r.get("/routines/today", asyncRoute(async (req, res) => respond(res, await readTodayPlan(identityOf(req), { agentKey }))));

  // ── Future Self ─────────────────────────────────────────────────────────
  r.get("/future/aspirations", asyncRoute(async (req, res) => respond(res, await readFutureOverview(identityOf(req), { agentKey }))));
  r.get("/future/aspirations/:id", asyncRoute(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return badId(res);
    respond(res, await readAspiration(identityOf(req), { agentKey, aspirationId: req.params.id }));
  }));

  r.get("/future/aspirations/:id/states", asyncRoute(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return badId(res);
    respond(res, await readStateTimeline(identityOf(req), { agentKey, aspirationId: req.params.id }));
  }));

  // ── Learning Lab ────────────────────────────────────────────────────────
  r.get("/learning/topics", asyncRoute(async (req, res) => respond(res, await readLearningOverview(identityOf(req), { agentKey }))));
  r.get("/learning/due", asyncRoute(async (req, res) => {
    const q = z.object({ topicId: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: q.error.flatten() });
    respond(res, await readDueCards(identityOf(req), { agentKey, ...q.data }));
  }));
  r.get("/learning/sessions", asyncRoute(async (req, res) => respond(res, await readSessions(identityOf(req), { agentKey }))));
  r.get("/learning/objectives", asyncRoute(async (req, res) => respond(res, await readObjectives(identityOf(req), { agentKey }))));
  r.get("/learning/experiments", asyncRoute(async (req, res) => respond(res, await readExperiments(identityOf(req), { agentKey }))));
  r.get("/learning/experiments/:id", asyncRoute(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return badId(res);
    respond(res, await readExperiment(identityOf(req), { agentKey, experimentId: req.params.id }));
  }));
  r.get("/learning/cards/:id", asyncRoute(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return badId(res);
    respond(res, await readCard(identityOf(req), { agentKey, cardId: req.params.id }));
  }));

  return r;
}
