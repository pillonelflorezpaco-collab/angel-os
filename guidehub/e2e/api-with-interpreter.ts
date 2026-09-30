// E2E-only launcher: the real API plus a SCRIPTED interpreter, so the cockpit's Capture screen can be driven end to end without a model.
// Not used by production (`npm start` runs api/server.ts with no interpreter). Run with tsx from the repo root:
//   ANGEL_OS_SYSTEM_PRINCIPAL_ID=<uuid> PORT=3155 npx tsx guidehub/e2e/api-with-interpreter.ts
process.env.NODE_ENV = "test"; // stops api/server.ts from starting its own default listener on import
const { createApp } = await import("../../api/server.js");
const { ScriptedModelProvider } = await import("../../capture/provider.js");
const { registerSkillActions, verifyProductionActions } = await import("../../skills/manifest.js");

const provider = new ScriptedModelProvider(({ text }) => {
  if (text.startsWith("E2E-MIXED")) {
    return { candidates: [
      { type: "EXPERIENCE", content: "E2E worked three hours on Angel OS." },
      { type: "INFERENCE", content: "E2E real-world testing should come before more features.", confidence: 0.95 },
      { type: "NEXT_ACTION", title: "E2E run the validation scenarios" },
      { type: "FUTURE_SELF_STATE", aspiration: { title: "Angel OS as a daily system" }, current: "E2E exists but unused", desired: "E2E used daily", evidenceFrom: [] },
      { type: "DISCOVERY", content: "not a kind of record" },
    ], clarifications: [{ question: "E2E Do you mean you personally tested this, or learned it as general knowledge?", options: ["I tested it", "General knowledge"] }] };
  }
  if (text.startsWith("E2E-CANCEL")) return { candidates: [{ type: "NEXT_ACTION", title: "E2E never saved" }] };
  return { candidates: [] };
});
registerSkillActions();
await verifyProductionActions();
createApp({ captureProvider: provider }).listen(Number(process.env.PORT ?? 3155), () => console.log("E2E API with scripted interpreter"));
