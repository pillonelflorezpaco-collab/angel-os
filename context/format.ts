import type { ContextPackage } from "../core/types/index.js";

/**
 * Renders a ContextPackage as plain text for a human (or a deterministic
 * reply). It preserves the semantics the package carries: memory labels keep
 * FACT vs INFERENCE, contradicted knowledge is marked, and sections the
 * caller may not read (or that failed) are stated, never silently dropped.
 */
export function formatContext(ctx: ContextPackage): string {
  const lines: string[] = [];
  if (ctx.relevantMemories.length) {
    lines.push("What I know about you:");
    for (const m of ctx.relevantMemories) lines.push(`• ${m.label ?? `[${m.type.toLowerCase()}] ${m.content}`}${m.subject ? ` (about ${m.subject})` : ""}`);
  }
  if (ctx.relevantKnowledge.length) {
    lines.push("Knowledge:");
    for (const k of ctx.relevantKnowledge) {
      const tag = k.kind ? `[${k.kind.toLowerCase()}${k.contradicted ? ", disputed" : ""}] ` : "";
      lines.push(`• ${tag}${k.title}${k.excerpt && k.excerpt !== k.title ? ` — ${k.excerpt}` : ""}`);
    }
  }
  if (ctx.relevantDecisions?.length) {
    lines.push("Decisions:");
    for (const d of ctx.relevantDecisions) lines.push(`• ${d.title}: ${d.decision}`);
  }
  if (ctx.activeGoals?.length) {
    lines.push("Goals:");
    for (const g of ctx.activeGoals) lines.push(`• ${g.title}`);
  }
  if (ctx.activeProjects?.length) {
    lines.push("Projects:");
    for (const p of ctx.activeProjects) lines.push(`• ${p.name} [${p.status.toLowerCase()}, ${p.tasks.open} open / ${p.tasks.done} done]`);
  }
  if (ctx.activeAspirations?.length) {
    lines.push("Aspirations:");
    for (const a of ctx.activeAspirations) lines.push(`• ${a.title}: ${a.current} → ${a.desired} (${a.progress === null ? "no evidence yet" : `${Math.round(a.progress * 100)}% by recorded readings`})`);
  }
  if (ctx.activeLearning?.length) {
    lines.push("Learning:");
    for (const l of ctx.activeLearning) lines.push(`• ${l.title}: ${l.minutesLast7Days} min in the last 7 days (self-reported), ${l.due} of ${l.cards} cards due`);
  }
  if (ctx.currentTasks.length) {
    lines.push("Open tasks:");
    for (const t of ctx.currentTasks) lines.push(`• ${t.title} [${t.status.toLowerCase().replace("_", " ")}]`);
  }
  if (ctx.recentActivity?.length) {
    lines.push("Recently:");
    for (const a of ctx.recentActivity) lines.push(`• ${a.summary}`);
  }
  if (ctx.withheld.length) lines.push(`Not available to me (no permission): ${ctx.withheld.join(", ")}.`);
  if (ctx.unavailable?.length) lines.push(`Could not be read right now: ${ctx.unavailable.join(", ")}.`);
  return lines.length ? lines.join("\n") : "I don't have anything relevant.";
}
