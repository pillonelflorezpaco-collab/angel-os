import express from "express";
import { z } from "zod";
import { statusFor } from "./lifeRoutes.js";
import { interpretCapture, confirmCapture, cancelCapture, MAX_TEXT_CHARS } from "../skills/system/capture.js";
import type { CaptureModelProvider } from "../capture/provider.js";
import { asyncRoute, identityOf } from "./middleware.js";

// Capture over HTTP — an ADAPTER. Identity comes from the authenticated token; the model (if one is connected) only interprets;
// nothing is saved by POST /capture (it returns a DRAFT); confirming runs each item as an ordinary ActionDefinition proposal.
//   POST /api/capture                 { text }                → a draft proposal (nothing saved)
//   POST /api/capture/:id/confirm     { accept?: number[] }   → per-item outcomes (EXECUTED · PENDING_APPROVAL · DENIED · FAILED · SKIPPED)
//   POST /api/capture/:id/cancel      {}                      → nothing is ever written
// With no interpreter connected, POST /capture answers 503 — it never pretends to understand.

const uuid = z.string().uuid();
const interpretBody = z.object({ text: z.string().max(MAX_TEXT_CHARS * 2) }).strict();
const confirmBody = z.object({ accept: z.array(z.number().int().min(0).max(7)).max(8).optional() }).strict();
const cancelBody = z.object({}).strict();

export function captureRouter(provider: CaptureModelProvider | undefined): express.Router {
  const r = express.Router();
  const bad = (res: express.Response, error: unknown) => res.status(400).json({ error });

  r.post("/capture", asyncRoute(async (req, res) => {
    const body = interpretBody.safeParse(req.body ?? {});
    if (!body.success) return bad(res, body.error.flatten());
    if (!provider) return res.status(503).json({ status: "FAILED", message: "No interpreter is connected yet, so Jarvis can't turn sentences into proposals. Nothing was saved." });
    const result = await interpretCapture(identityOf(req), { text: body.data.text, provider });
    res.status(statusFor(result)).json(result);
  }));

  r.post("/capture/:id/confirm", asyncRoute(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, "Invalid id.");
    const body = confirmBody.safeParse(req.body ?? {});
    if (!body.success) return bad(res, body.error.flatten());
    const result = await confirmCapture(identityOf(req), { proposalId: req.params.id, accept: body.data.accept });
    res.status(statusFor(result)).json(result);
  }));

  r.post("/capture/:id/cancel", asyncRoute(async (req, res) => {
    if (!uuid.safeParse(req.params.id).success) return bad(res, "Invalid id.");
    const body = cancelBody.safeParse(req.body ?? {});
    if (!body.success) return bad(res, body.error.flatten());
    const result = await cancelCapture(identityOf(req), { proposalId: req.params.id });
    res.status(statusFor(result)).json(result);
  }));

  return r;
}
