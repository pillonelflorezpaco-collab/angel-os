// One-off operator migration: ingest a directory of Markdown files as ONE principal's own knowledge
// (Knowledge OS). Used when the legacy global Markdown knowledge base was retired.
//
//   npm run ingest-markdown -- <principalId> <directory>
//
// Idempotent (the store de-duplicates by content hash) and audited. It writes only to the principal named on the
// command line by an operator with shell access; nothing here is reachable from an interface.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getKnowledgeStore } from "../knowledge/store/index.js";
import { recordAuditEvent } from "../gateway/index.js";
import { disconnectDb, getDb } from "../db/client/index.js";

async function main() {
  const [principalId, dir] = process.argv.slice(2);
  if (!principalId || !dir) {
    console.error("Usage: ingest-markdown <principalId> <directory>");
    process.exit(2);
  }
  const principal = await getDb().principal.findUnique({ where: { id: principalId }, select: { id: true } });
  if (!principal) {
    console.error("No such principal.");
    process.exit(1);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const content = readFileSync(path.join(dir, file), "utf-8");
    const out = await getKnowledgeStore().ingest(principalId, { title: file.replace(/\.md$/, ""), sourceKind: "markdown-import", format: "markdown", content });
    await recordAuditEvent({
      principalId,
      eventType: "ACTION_EXECUTION_SUCCEEDED",
      resource: "angel:knowledge",
      action: "KNOWLEDGE_INGEST",
      result: "SUCCESS",
      source: "scripts.ingest-markdown",
      metadata: { file, sourceId: out.sourceId, duplicate: out.duplicate, itemCount: out.itemCount },
    });
    console.log(`${file}: ${out.duplicate ? "already ingested" : `${out.itemCount} items, ${out.relationCount} relations`}`);
  }
  await disconnectDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "Ingest failed.");
  process.exit(1);
});
