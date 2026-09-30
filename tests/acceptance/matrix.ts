// Collects honest per-stage grades during the real-world run and prints them at the end. Grades are evidence for the report;
// they are NOT assertions (assertions are the expect() calls next to them).
export type Grade = "PASS" | "PARTIAL" | "FAIL" | "NOT IMPLEMENTED";
export type Stage = string;
const rows: { scenario: string; stage: Stage; grade: Grade; note: string }[] = [];
export const record = (scenario: string, stage: Stage, grade: Grade, note: string) => { rows.push({ scenario, stage, grade, note }); };
export function printMatrix() {
  const out = rows.map((r) => `${r.scenario} | ${r.stage} | ${r.grade} | ${r.note}`).join("\n");
  if (process.env.ACCEPTANCE_MATRIX_FILE) import("node:fs").then((fs) => fs.writeFileSync(process.env.ACCEPTANCE_MATRIX_FILE!, out + "\n"));
  console.log("\n=== ACCEPTANCE MATRIX ===\n" + out + "\n=== END ===");
}
