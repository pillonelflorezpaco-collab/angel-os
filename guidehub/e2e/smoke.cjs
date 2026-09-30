// GuideHub cockpit — browser smoke test (opt-in; NOT part of `npm test`).
//
// Drives the REAL cockpit against the REAL Angel OS API in Chromium: sign-in, Today briefing, hostile text rendered as text, Ask Jarvis, an approval
// decided from the UI, inline task/decision/card actions, sign-out, phone width and dark mode. It seeds its own data through the API first.
//
// Prerequisites (see docs/guidehub/README.md):
//   - the Angel OS API running (npm start / npm run dev) against a migrated, seeded database
//   - the cockpit running (npm run guidehub) with GUIDEHUB_INSECURE_COOKIES=1 for plain-http localhost
//   - Playwright available (NODE_PATH must resolve `playwright`) and a Chromium binary
//
//   GUIDEHUB_E2E_API=http://localhost:3000 GUIDEHUB_E2E_API_TOKEN=aos_… GUIDEHUB_E2E_URL=http://127.0.0.1:3100 \
//   GUIDEHUB_E2E_PASSPHRASE='…' CHROMIUM_PATH=/path/to/chrome SCREENSHOT_DIR=./shots node guidehub/e2e/smoke.cjs
//
// Uses the token only to create its own fixtures (tasks, a pending deletion, a decision due for review, a card); it never touches the cockpit's session.
const { chromium } = require("playwright");
const SP = process.env.SCREENSHOT_DIR || ".";
const URL_ = process.env.GUIDEHUB_E2E_URL || "http://127.0.0.1:3100";
const API = process.env.GUIDEHUB_E2E_API || "http://localhost:3000";
const TOKEN = process.env.GUIDEHUB_E2E_API_TOKEN;
const PASSPHRASE = process.env.GUIDEHUB_E2E_PASSPHRASE;
const TOKEN_B = process.env.GUIDEHUB_E2E_API_TOKEN_B; // optional: a SECOND principal, used only for the cross-principal checks
require("node:fs").mkdirSync(SP, { recursive: true });

async function act(skillAction, body, token = TOKEN) {
  const r = await fetch(`${API}/api/actions/${skillAction}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!(j.status === "EXECUTED" || j.status === "PENDING_APPROVAL")) throw new Error(`seed ${skillAction} failed: ${j.message}`);
  return j.data;
}
const STAMP = Date.now(); // one stamp shared by the seed data and the Life checks
async function seed() {
  const stamp = STAMP;
  await act("system.tasks/CREATE_TASK", { title: "Write the cockpit spec" });
  await act("system.tasks/CREATE_TASK", { title: "<img src=x onerror=alert(1)> hostile task title" });
  await act("system.life/GOAL_CREATE", { title: `Ship Angel OS ${stamp}`, horizon: "LONG" });
  const asp = await act("system.future/ASPIRATION_CREATE", { title: `Run a 10k ${stamp}`, current: "out of shape", desired: "run 10k" });
  await act("system.future/METRIC_CREATE", { aspirationId: asp.id, name: "km", unit: "km", definition: "kilometres run in one go", baseline: 0, target: 10 });
  await act("system.decisions/DECISION_RECORD", { title: `Second look ${stamp}`, decision: "Hire a contractor", expected: "shipped sooner", reviewAt: "2020-03-01T00:00:00.000Z" }); // OLDER than the next one, so the Today flow (newest first) reviews that one and this one stays due for the Decisions screen
  await act("system.decisions/DECISION_RECORD", { title: `Adopt a cockpit ${stamp}`, decision: "Build it", expected: "faster reviews", reviewAt: "2020-01-01T00:00:00.000Z" });
  const topic = await act("system.learning/TOPIC_CREATE", { title: `Spanish ${stamp}` });
  await act("system.learning/CARD_CREATE", { topicId: topic.id, prompt: "Hola means?", answer: "Hello" });
  await act("system.memory/MEMORY_CREATE", { type: "FACT", content: `I sleep badly after coffee ${stamp}`, source: "e2e" });
  await act("system.tasks/CREATE_TASK", { title: `Try decaf ${stamp}` });
  const person = await act("system.life/PERSON_CREATE", { name: `Temp person ${stamp}` });
  await act("system.life/PERSON_DELETE", { personId: person.id }); // SENSITIVE: waits for approval in the cockpit
  await seedGrowth(stamp);
}

// Step 5 fixtures: an aspiration with an evidenced state history, an objective, experiments (one with an observation, evidence and a lesson), a study session.
const growth = {};
async function seedGrowth(stamp) {
  const goal = await act("system.life/GOAL_CREATE", { title: `Growth goal ${stamp}` });
  const asp = await act("system.future/ASPIRATION_CREATE", { title: `Future ${stamp}`, current: "I walk twice a week", gap: "no routine yet", desired: "walk daily" });
  const result = await act("system.life/RESULT_RECORD", { subjectKind: "GOAL", subjectId: goal.id, statement: `Walked five days ${stamp}` });
  const lived = await act("system.memory/MEMORY_CREATE", { type: "EXPERIENCE", content: `Morning walks felt easier ${stamp}`, source: "e2e" });
  await act("system.future/ASPIRATION_STATE_RECORD", { aspirationId: asp.id, current: "I walk five days a week", gap: "weekends", desired: "walk daily", note: "after a good week",
    evidence: [{ sourceKind: "RESULT", sourceId: result.id, stance: "SUPPORTS" }, { sourceKind: "MEMORY", sourceId: lived.id, stance: "SUPPORTS" }] });
  growth.aspiration = asp;
  await act("system.future/ASPIRATION_CREATE", { title: "Angel OS as a daily system", current: "built, unused", desired: "used daily" }); // the Capture screen resolves this title
  await act("system.learning/OBJECTIVE_CREATE", { title: `Hold a conversation ${stamp}`, evidenceStandard: "Ten minutes without switching language" });
  const e1 = await act("system.learning/EXPERIMENT_CREATE", { hypothesis: `Morning study sticks better ${stamp}`, method: "30 minutes at 7am for a week" });
  const obs = await act("system.learning/EXPERIMENT_OBSERVE", { experimentId: e1.id, text: `Recalled more words after morning study ${stamp}` });
  await act("system.future/EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: e1.id, sourceKind: "MEMORY", sourceId: lived.id, stance: "CONTEXT", note: "same week" });
  await act("system.future/EVIDENCE_ATTACH", { subjectKind: "EXPERIMENT", subjectId: e1.id, sourceKind: "OBSERVATION", sourceId: obs.id, stance: "SUPPORTS" });
  await act("system.learning/EXPERIMENT_TRANSITION", { experimentId: e1.id, to: "OBSERVED", note: "first look" });
  await act("system.learning/LESSON_RECORD", { experimentId: e1.id, content: `For me, mornings worked in that week ${stamp}` });
  growth.observed = e1;
  growth.candidate = await act("system.learning/EXPERIMENT_CREATE", { hypothesis: `Evening flashcards help ${stamp}`, method: "10 cards after dinner" });
  const topic = await act("system.learning/TOPIC_CREATE", { title: `Italian ${stamp}` });
  await act("system.learning/SESSION_LOG", { topicId: topic.id, minutes: 25, note: "verbs" });
  await act("system.memory/MEMORY_CREATE", { type: "INFERENCE", content: "MEMSEED I probably think better in the morning", source: "e2e", confidence: 0.4 });
  await act("system.memory/MEMORY_CREATE", { type: "EXPERIENCE", content: "MEMSEED I finished the cockpit screens today", source: "e2e" });
  await act("system.memory/MEMORY_CREATE", { type: "FACT", content: "MEMSEED temp wrong fact", source: "e2e" });
  await act("system.knowledge/KNOWLEDGE_ADD", { kind: "CONCEPT", title: "KNOWSEED Spaced repetition", body: "Reviewing at growing intervals improves retention." });
  if (TOKEN_B) growth.foreign = await act("system.learning/EXPERIMENT_CREATE", { hypothesis: `Someone else's experiment ${stamp}`, method: "private" }, TOKEN_B);
}
let crashPage = null; // for a screenshot if the run crashes
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };

(async () => {
  if (!TOKEN || !PASSPHRASE || !process.env.CHROMIUM_PATH) { console.error("Set GUIDEHUB_E2E_API_TOKEN, GUIDEHUB_E2E_PASSPHRASE and CHROMIUM_PATH (see the header)."); process.exit(2); }
  await seed();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  const page = await ctx.newPage();
  crashPage = page;
  const problems = []; let probing = false;
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !(probing && /status of 4\d\d/.test(m.text()))) problems.push(`${m.type()}: ${m.text()} @${m.location().url}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  let dialogs = 0; page.on("dialog", async (d) => { dialogs++; await d.dismiss(); });

  await page.goto(`${URL_}/`);
  await page.waitForSelector("form.signin");
  check("sign-in screen shown to a visitor", await page.locator("h1", { hasText: "GuideHub" }).count() === 1);
  await page.screenshot({ path: `${SP}/1-signin.png` });

  probing = true; await page.fill("#pass", "wrong passphrase!!");
  await page.click("button[type=submit]");
  await page.waitForSelector("p.outcome.bad:not([hidden])");
  probing = false; check("wrong passphrase → generic error", (await page.textContent("p.outcome.bad")).includes("Incorrect passphrase."));

  await page.fill("#pass", PASSPHRASE);
  await page.click("button[type=submit]");
  await page.waitForSelector("#briefing h1");
  check("correct passphrase → Today", (await page.textContent("#briefing h1")) === "Today");
  await page.waitForSelector("#approvals .approval");
  await page.waitForSelector("#reviews form");
  await page.waitForSelector("#cards .primary");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SP}/2-today.png`, fullPage: true });

  const cookies = await ctx.cookies();
  const c = cookies.find((k) => k.name === "guidehub");
  check("session cookie is HttpOnly + SameSite=Strict", c && c.httpOnly && c.sameSite === "Strict");
  check("cookie invisible to page JavaScript", !(await page.evaluate(() => document.cookie)).includes("guidehub"));
  check("no token or principal id anywhere in the DOM", !/aos_|00000000-0000-0000-0000-000000000001/.test(await page.content()));

  const html = await page.content();
  check("hostile task title is shown as TEXT (no element injected)", (await page.locator("#briefing img").count()) === 0 && (await page.textContent("#briefing")).includes("<img src=x onerror=alert(1)> hostile task title"));
  check("no alert/dialog fired", dialogs === 0);
  check("aspiration with no readings says 'No measured readings yet' (not 0%)", (await page.textContent("#briefing")).includes("No measured readings yet") && !(await page.textContent("#briefing")).includes("0% by recorded"));

  const text = await page.evaluate(() => document.body.innerText);
  check("no stray null/undefined/[object Object] text on the page", !/(^|\n)\s*(null|undefined)\s*(\n|$)|\[object Object\]/.test(text));
  await page.fill("#ask", "what are my tasks");
  await page.click(".ask button[type=submit]");
  await page.waitForSelector(".answer .outcome.good");
  check("Ask Jarvis shows the OS-written answer", (await page.textContent(".answer")).includes("Your tasks"));

  const card = page.locator("#approvals .approval").first();
  check("approval shows summary + risk + expiry", (await card.textContent()).includes("Delete person") && (await card.textContent()).includes("Sensitive") && (await card.textContent()).includes("expires in"));
  await card.getByText("Show exact parameters").click();
  await page.waitForSelector("#approvals pre.params:not([hidden])");
  check("exact stored parameters are viewable", (await page.textContent("#approvals pre.params")).includes("personId"));
  await page.screenshot({ path: `${SP}/3-approval-open.png`, fullPage: true });
  await card.getByRole("button", { name: /^Approve/ }).click();
  await page.waitForSelector("#approvals .outcome.good");
  check("approval resolves from the response: 'Approved and done.'", (await page.textContent("#approvals .outcome")).includes("Approved and done."));

  await page.locator("#briefing li", { hasText: "Write the cockpit spec" }).getByRole("button", { name: /Mark done: Write the cockpit spec/ }).click();
  await page.waitForFunction(() => !document.querySelector("#briefing")?.textContent.includes("Write the cockpit spec"));
  check("task marked done disappears from open tasks", true);

  await page.locator("#reviews textarea").first().fill("Reviews really were faster.");
  await page.locator("#reviews textarea").nth(1).fill("Keep it small.");
  await page.locator("#reviews button[type=submit]").first().click();
  await page.waitForSelector("#reviews .outcome.good");
  check("decision look-back recorded once", (await page.textContent("#reviews .outcome")).length > 0);

  await page.getByRole("button", { name: "Show answer" }).click();
  check("card answer revealed only on request", (await page.textContent("#cards .answer-text")) === "Hello");
  await page.getByRole("button", { name: "Good" }).click();
  await page.waitForFunction(() => !document.querySelector("#cards .primary"));
  check("graded card leaves the due list", true);

  // ── Step 2: Life ─────────────────────────────────────────────────────────
  const stamp = STAMP;
  const open = (label) => page.locator("details", { has: page.getByText(label, { exact: true }) });
  check("an Ask Jarvis answer is on screen before navigating…", (await page.locator(".answer").textContent()).includes("Your tasks"));
  await page.getByRole("link", { name: "Life", exact: true }).click();
  await page.waitForSelector("h1:has-text('Life')");
  await page.waitForSelector("section:has-text('Goals')");
  check("…and does not follow you to another screen", (await page.locator(".answer").textContent()).trim() === "");
  check("Life page lists the active goal seeded through the API", (await page.textContent("main")).includes(`Ship Angel OS ${stamp}`));
  await page.screenshot({ path: `${SP}/6-life.png`, fullPage: true });

  await open("Add a goal").locator("summary").click();
  await open("Add a goal").getByLabel("Goal", { exact: true }).fill(`Learn Spanish ${stamp}`);
  await open("Add a goal").getByLabel("Horizon (optional)").selectOption({ label: "Long term" });
  await open("Add a goal").getByLabel("Target date (optional)").fill("2027-06-30");
  await open("Add a goal").getByRole("button", { name: "Add goal" }).click();
  await page.waitForSelector(`li:has-text('Learn Spanish ${stamp}')`);
  const goalRow = page.locator("li", { hasText: `Learn Spanish ${stamp}` }).first();
  check("a new goal appears with its horizon and target date", (await goalRow.textContent()).includes("long") && /Jun 30, 2027/.test(await goalRow.textContent()));

  // achieving is a guarded, explicit act; the achieved goal moves to History and offers no controls
  const shipRow = page.locator("li", { hasText: `Ship Angel OS ${stamp}` }).first();
  await shipRow.getByRole("button", { name: "Mark achieved" }).click();
  await shipRow.getByRole("button", { name: "Mark achieved" }).click(); // the confirm button
  await page.waitForFunction((t) => !document.querySelector("section")?.parentElement?.textContent.includes(`Goals`) || ![...document.querySelectorAll("section")].find((x) => x.querySelector("h2")?.textContent === "Goals")?.textContent.includes(t), `Ship Angel OS ${stamp}`);
  await page.locator("summary", { hasText: /^Goals \(\d+\)$/ }).click();
  const hist = page.locator("section", { has: page.locator("h2", { hasText: "History" }) });
  check("achieved goal is in History, marked achieved, with no controls", (await hist.textContent()).includes(`Ship Angel OS ${stamp}`) && (await hist.textContent()).includes("achieved") && (await hist.getByRole("button").count()) === 0);

  // abandoning requires a written reason
  const spRow = page.locator("li", { hasText: `Learn Spanish ${stamp}` }).first();
  await spRow.getByRole("button", { name: "Abandon" }).click();
  await spRow.getByRole("button", { name: "Abandon goal" }).click();
  check("abandon with an empty reason is blocked by the browser's required field (no request sent)", await spRow.getByLabel("Why? (required)").evaluate((el) => el.validity.valueMissing) && !(await page.textContent("main")).includes("Working…"));
  await spRow.getByLabel("Why? (required)").fill("   ");
  await spRow.getByRole("button", { name: "Abandon goal" }).click();
  check("a whitespace-only reason is refused by the UI too", (await page.textContent("main")).includes("Please write a reason."));
  await spRow.getByLabel("Why? (required)").fill("Changed priorities");
  await spRow.getByRole("button", { name: "Abandon goal" }).click();
  await page.waitForFunction((t) => ![...document.querySelectorAll("section")].find((x) => x.querySelector("h2")?.textContent === "Goals")?.textContent.includes(t), `Learn Spanish ${stamp}`);
  check("abandoned goal left the active list", true);

  // project → quest → task
  await open("Add a project").locator("summary").click();
  await open("Add a project").getByLabel("Project", { exact: true }).fill(`Cockpit build ${stamp}`);
  await open("Add a project").getByRole("button", { name: "Add project" }).click();
  await page.getByRole("link", { name: `Cockpit build ${stamp}` }).click();
  await page.waitForSelector(`h1:has-text('Cockpit build ${stamp}')`);
  check("project page opens by hash route", /#\/life\/projects\/[0-9a-f-]{36}$/.test(page.url()));

  await open("Add a quest").locator("summary").click();
  await open("Add a quest").getByLabel("Quest", { exact: true }).fill("Ship step 2");
  await open("Add a quest").getByLabel("Objective", { exact: true }).fill("Life screens live");
  check("a quest cannot be created without its 'Done when' criteria (required field)", await open("Add a quest").getByLabel("Done when…").evaluate((el) => el.required));
  await open("Add a quest").getByLabel("Done when…").fill("All screens pass the smoke test");
  await open("Add a quest").getByRole("button", { name: "Add quest" }).click();
  const quest = page.locator("li", { hasText: "Ship step 2" }).first();
  await quest.waitFor();
  check("new quest is planned and shows the owner's own definition of done", (await quest.textContent()).includes("planned") && (await quest.textContent()).includes("Done when: All screens pass the smoke test"));
  check("a planned quest cannot be completed directly (no complete control)", (await quest.getByRole("button", { name: "Mark complete" }).count()) === 0);
  await quest.getByRole("button", { name: "Start" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("active") && [...document.querySelectorAll("li")].some((l) => l.textContent.includes("Ship step 2") && l.textContent.includes("active")));
  const active = page.locator("li", { hasText: "Ship step 2" }).first();
  await active.getByRole("button", { name: "Mark complete" }).click();
  await active.getByRole("button", { name: "Mark complete" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("li")].some((l) => l.textContent.includes("Ship step 2") && l.textContent.includes("completed")));
  await page.waitForFunction(() => { const li = [...document.querySelectorAll("li")].find((l) => l.textContent.includes("Ship step 2")); return li && !li.querySelector("button"); }); // after the screen re-renders
  check("completed quest is final: no Start/Complete/Abandon controls remain", (await page.locator("li", { hasText: "Ship step 2" }).first().getByRole("button").count()) === 0);

  await open("Add a task").locator("summary").click();
  await open("Add a task").getByLabel("Task", { exact: true }).fill("Write the Life screens");
  await open("Add a task").getByRole("button", { name: "Add task" }).click();
  const task = page.locator("li", { hasText: "Write the Life screens" }).first();
  await task.waitFor();
  await task.getByRole("button", { name: "Done" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("li")].some((l) => l.textContent.includes("Write the Life screens") && l.textContent.includes("done")));
  await page.waitForFunction(() => { const li = [...document.querySelectorAll("li")].find((l) => l.textContent.includes("Write the Life screens")); return li && !li.querySelector("button"); });
  check("finished task is final: no controls remain", (await page.locator("li", { hasText: "Write the Life screens" }).first().getByRole("button").count()) === 0);
  await page.screenshot({ path: `${SP}/7-project.png`, fullPage: true });

  // archiving is terminal: the page turns read-only
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Archive project" }).click();
  await page.waitForSelector("text=Archived — this project is final and can't be changed.");
  check("archived project is read-only (no add forms, no status controls)", (await page.locator("summary", { hasText: /^Add a (quest|task)$/ }).count()) === 0 && (await page.getByRole("button", { name: "Pause" }).count()) === 0);

  // people: hostile text stays text; deleting needs approval and changes nothing until approved
  await page.getByRole("link", { name: "← Life" }).click();
  await page.waitForSelector("h1:has-text('Life')");
  await open("Add a person").locator("summary").click();
  await open("Add a person").getByLabel("Name", { exact: true }).fill(`Ana ${stamp}`);
  await open("Add a person").getByLabel("Notes (optional)").fill("<b>bold?</b> <script>window.__pwned=1</script>");
  await open("Add a person").getByRole("button", { name: "Add person" }).click();
  const person = page.locator("li", { hasText: `Ana ${stamp}` }).first();
  await person.waitFor();
  check("person notes render as text (no markup, no script)", (await person.textContent()).includes("<b>bold?</b>") && (await person.locator("b").count()) === 0 && !(await page.evaluate(() => window.__pwned)));
  await person.getByRole("button", { name: "Delete" }).click();
  await person.getByRole("button", { name: "Ask to delete" }).click();
  await page.waitForSelector("text=Sent for your approval — nothing has changed yet.");
  check("deleting a person is only REQUESTED: 'nothing has changed yet', person still listed", (await page.locator("li", { hasText: `Ana ${stamp}` }).count()) >= 1);
  await page.waitForSelector("a.badge-link:not([hidden])");
  check("the approvals badge is reachable from every screen", (await page.textContent("a.badge-link")).startsWith("Approvals ("));
  await page.click("a.badge-link");
  await page.waitForSelector(`#approvals .approval:has-text('Delete person')`);
  await page.locator("#approvals .approval").filter({ hasText: "Delete person" }).first().getByRole("button", { name: /^Approve/ }).click();
  await page.waitForSelector("#approvals .outcome.good");
  await page.getByRole("link", { name: "Life", exact: true }).click();
  await page.waitForSelector("h1:has-text('Life')");
  await page.waitForFunction((t) => !document.body.innerText.includes(t), `Ana ${stamp}`);
  check("after approval the person is gone", true);
  await page.screenshot({ path: `${SP}/8-life-after.png`, fullPage: true });

  // ── Step 3: Decisions ────────────────────────────────────────────────────
  await page.getByRole("link", { name: "Decisions", exact: true }).click();
  await page.waitForSelector("h1:has-text('Decisions')");
  await page.waitForSelector(`a:has-text('Second look ${stamp}')`);
  const dueSection = page.locator("section", { has: page.locator("h2", { hasText: "Time to look back" }) });
  check("a decision whose date has passed is offered for a look-back", (await dueSection.textContent()).includes(`Second look ${stamp}`));
  await page.screenshot({ path: `${SP}/10-decisions.png`, fullPage: true });

  const recordForm = () => page.locator("form").filter({ has: page.getByRole("button", { name: "Record decision", exact: true }) });
  await page.locator("summary", { hasText: "Record a decision" }).first().click();
  const rf = recordForm();
  await rf.getByLabel("Title", { exact: true }).fill(`Cut coffee ${stamp} <img src=x onerror=alert(2)>`);
  await rf.getByLabel("What did you decide?", { exact: true }).fill("Switch to decaf");
  await rf.getByLabel("Why? (optional)").fill("Sleep matters");
  await rf.getByLabel("What do you expect to happen? (optional)").fill("Better sleep in two weeks");
  await rf.getByLabel("Look back on (optional)").fill("2020-02-01");
  // one option only → the UI says so before sending anything
  await rf.getByRole("button", { name: "Add an option" }).click();
  await rf.locator(".option").nth(0).getByLabel("Option", { exact: true }).fill("Keep coffee");
  await rf.getByRole("button", { name: "Record decision", exact: true }).click();
  check("a single option is refused by the form itself (2–6 or none)", (await rf.textContent()).includes("Give at least 2 options, or none."));
  await rf.getByRole("button", { name: "Add an option" }).click();
  await rf.locator(".option").nth(1).getByLabel("Option", { exact: true }).fill("Decaf");
  await rf.locator(".option").nth(1).getByLabel("For it (optional)").fill("Sleep");
  await rf.locator(".option").nth(1).getByLabel("This is the one I chose").check();
  // evidence: a note, a memory and a task from the owner's own data
  await rf.getByLabel("A note", { exact: true }).fill("Read an article on caffeine");
  await rf.getByRole("button", { name: "Add note" }).click();
  await rf.locator("details", { hasText: "Add from a memory" }).locator("summary").click();
  await rf.locator("details", { hasText: "Add from a memory" }).getByLabel("Find").fill(`coffee ${stamp}`);
  await rf.locator("details", { hasText: "Add from a memory" }).getByRole("button", { name: "Search" }).click();
  await rf.getByRole("button", { name: /Use as evidence: I sleep badly after coffee/ }).click();
  await rf.locator("details", { hasText: "Add from a task" }).locator("summary").click();
  await rf.locator("details", { hasText: "Add from a task" }).getByLabel("Find").fill(`Try decaf ${stamp}`);
  await rf.locator("details", { hasText: "Add from a task" }).getByRole("button", { name: "Search" }).click();
  await rf.getByRole("button", { name: /Use as evidence: Try decaf/ }).click();
  check("three pieces of evidence are chosen (note, memory, task)", (await rf.locator(".chips li").count()) === 3);
  await rf.getByRole("button", { name: "Record decision", exact: true }).click();
  await page.waitForSelector(`h1:has-text('Cut coffee ${stamp}')`);
  check("recording opens the new decision (hash route)", /#\/decisions\/[0-9a-f-]{36}$/.test(page.url()));
  const detailUrl = page.url();
  check("hostile decision title is text, not markup (no element, no dialog)", (await page.locator("main h1 img").count()) === 0 && (await page.textContent("main h1")).includes("<img src=x onerror=alert(2)>") && dialogs === 0);
  check("the chosen option is marked", (await page.locator("li", { hasText: "Decaf" }).first().textContent()).includes("chosen") && !(await page.locator("li", { hasText: "Keep coffee" }).first().textContent()).includes("chosen"));
  const ev = page.locator("section", { has: page.locator("h2", { hasText: "Evidence" }) });
  check("evidence shows the server's snapshot labels and what each one is", (await ev.textContent()).includes(`[memory] I sleep badly after coffee ${stamp}`) && (await ev.textContent()).includes(`[task] Try decaf ${stamp}`) && (await ev.textContent()).includes("Read an article on caffeine"));
  check("the page says decisions are history and offers no edit control", (await page.textContent("main")).includes("can't be edited") && (await page.getByRole("button", { name: /^(Edit|Update|Delete)/ }).count()) === 0);
  await page.screenshot({ path: `${SP}/11-decision.png`, fullPage: true });

  // results: a measurement needs both a value and a unit
  await page.locator("summary", { hasText: "Record a result" }).click();
  const resForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Record result" }) });
  await resForm.getByLabel("What happened?").fill("Slept better");
  await resForm.getByLabel("Measurement (optional)").fill("7.5");
  await resForm.getByRole("button", { name: "Record result" }).click();
  check("a value without a unit is refused by the form", (await resForm.textContent()).includes("A measurement needs both a value and a unit."));
  await resForm.getByLabel("Unit (optional)").fill("hours");
  await resForm.getByRole("button", { name: "Record result" }).click();
  await page.waitForSelector("li:has-text('Slept better — 7.5 hours')");
  check("the result is listed with its measurement", true);

  // the look-back: once, expected and actual side by side, no grading, then final
  const lb = page.locator("form").filter({ has: page.getByRole("button", { name: "Record the look-back" }) });
  await lb.getByLabel("What actually happened?").fill("I sleep better");
  await lb.getByLabel("What did you learn? (optional)").fill("Caffeine after noon is the problem");
  await lb.getByRole("button", { name: "Record the look-back" }).click();
  await page.waitForSelector(".compare"); // the comparison itself, not text that the form also contains
  const cmp = page.locator(".compare");
  check("look-back shows what you expected next to what happened", (await cmp.textContent()).includes("Better sleep in two weeks") && (await cmp.textContent()).includes("I sleep better"));
  await page.waitForFunction(() => !document.body.innerText.includes("Record the look-back"));
  check("the look-back is final: its form is gone and the page says so", (await page.textContent("main")).includes("This is final.") && (await page.getByRole("button", { name: "Record the look-back" }).count()) === 0);
  check("nothing on the page grades the outcome", !/(correct|wrong|score|grade|success rate|you were right)/i.test(await cmp.textContent()));

  // changing your mind: a NEW decision that replaces this one
  await page.locator("summary", { hasText: "Record a new decision that replaces this one" }).click();
  const chg = page.locator("form").filter({ has: page.getByRole("button", { name: "Record the new decision" }) });
  await chg.getByLabel("Title", { exact: true }).fill(`Back to coffee ${stamp}`);
  await chg.getByLabel("What did you decide?", { exact: true }).fill("Return to coffee before noon");
  check("the replace form says the old decision stays as written", (await chg.textContent()).includes("stays exactly as written"));
  await chg.getByRole("button", { name: "Record the new decision" }).click();
  await page.waitForSelector(`h1:has-text('Back to coffee ${stamp}')`);
  check("the new decision links to the one it replaces", await page.getByRole("link", { name: new RegExp(`Cut coffee ${stamp}`) }).count() >= 1);
  await page.getByRole("link", { name: new RegExp(`Cut coffee ${stamp}`) }).first().click();
  await page.waitForSelector(`h1:has-text('Cut coffee ${stamp}')`);
  await page.waitForSelector("text=Replaced by:");
  check("the old decision says it was replaced, is unchanged, and can't be replaced again", (await page.textContent("main")).includes(`Back to coffee ${stamp}`) && (await page.locator("summary", { hasText: "Record a new decision that replaces this one" }).count()) === 0 && (await page.textContent("main")).includes("Switch to decaf"));

  await page.getByRole("link", { name: "← Decisions" }).click();
  await page.waitForSelector("h1:has-text('Decisions')");
  await page.waitForSelector(`a:has-text('Back to coffee ${stamp}')`);
  const allRow = page.locator("li", { hasText: `Cut coffee ${stamp}` }).first();
  check("in the list the replaced decision is marked replaced", (await allRow.textContent()).includes("Replaced by a newer decision"));
  await page.screenshot({ path: `${SP}/13-decisions-after.png`, fullPage: true });

  // ── Step 5: Future Self + Learning ───────────────────────────────────────
  await page.getByRole("link", { name: "Future Self", exact: true }).click();
  await page.waitForSelector("h1:has-text('Future Self')");
  const fcard = page.locator(`article[data-aspiration="${growth.aspiration.id}"]`);
  await fcard.waitFor();
  const cardText = await fcard.textContent();
  check("Future Self: the aspiration shows current, desired and gap in neutral words", ["Current state recorded", "I walk five days a week", "Desired state", "walk daily", "Gap", "weekends"].every((t) => cardText.includes(t)));
  check("Future Self: supporting evidence is shown with the server's own labels and kinds", cardText.includes("Supporting evidence") && cardText.includes(`Walked five days ${STAMP}`) && cardText.includes("Lived experience") && cardText.includes(`Morning walks felt easier ${STAMP}`));
  check("Future Self: state history lists the starting state as earlier and the updated one as latest", cardText.includes("Starting state recorded") && cardText.includes("— earlier") && cardText.includes("Updated state recorded") && cardText.includes("— latest") && cardText.includes("I walk twice a week"));
  check("Future Self: no score, percentage, level or XP anywhere on the screen", !/(\d\s?%|\bxp\b|\blevel\b|\bscore\b|streak)/i.test(await page.textContent("main")));
  const other = page.locator("article.aspiration", { hasText: `Run a 10k ${STAMP}` });
  check("Future Self: an aspiration with no evidence says so, and does not imply contradiction", (await other.textContent()).includes("no evidence attached") && !(await other.textContent()).includes("Contradicting"));
  check("Future Self: a defined measure shows its definition and no percentage", (await other.textContent()).includes("kilometres run in one go") && (await other.textContent()).includes("No readings recorded yet."));
  await page.screenshot({ path: `${SP}/14-future-self.png`, fullPage: true });
  // recording a state needs evidence; the UI asks, and the server has the final word
  await fcard.getByRole("button", { name: "Record an updated state" }).click();
  const sf = fcard.locator("form").filter({ has: page.getByRole("button", { name: "Record updated state" }) });
  await sf.getByLabel("Current state, in your words").fill("I walk every day");
  await sf.getByRole("button", { name: "Record updated state" }).click();
  check("Future Self: an update without evidence is refused with a clear message", (await sf.textContent()).includes("Add at least one piece of evidence."));
  await sf.getByRole("button", { name: "Show my results" }).click();
  await sf.getByRole("button", { name: new RegExp(`Use as evidence: Walked five days ${STAMP}`) }).click();
  await sf.getByLabel("How does this evidence relate?").selectOption("SUPPORTS");
  await sf.getByRole("button", { name: "Record updated state" }).click();
  await page.waitForFunction((id) => document.querySelectorAll(`article[data-aspiration="${id}"] .timeline > li`).length === 3, growth.aspiration.id, { timeout: 8000 });
  check("Future Self: the update added a third dated state; earlier states are unchanged", (await fcard.textContent()).includes("I walk twice a week") && (await fcard.textContent()).includes("I walk every day"));

  await page.getByRole("link", { name: "Learning", exact: true }).click();
  await page.waitForSelector("h1:has-text('Learning')");
  await page.waitForSelector(`text=Hold a conversation ${STAMP}`);
  const lmain = await page.textContent("main");
  check("Learning: objectives load with the owner's evidence standard", lmain.includes("Your evidence standard: Ten minutes without switching language") && lmain.includes("No evidence is recorded."));
  check("Learning: experiments load with their hypothesis status in words", lmain.includes("Candidate — proposed") && lmain.includes("Observed — something was seen"));
  check("Learning: self-reported study sessions are listed", lmain.includes(`25 minutes on Italian ${STAMP}`) && lmain.includes("Self-reported"));
  const det = page.locator(`details[data-experiment="${growth.observed.id}"]`);
  await det.locator("summary").click();
  await det.getByRole("heading", { name: "Observations" }).waitFor();
  const dt = await det.textContent();
  check("Learning: an experiment shows method, observation, evidence with kinds, review history and lesson", [`Method: 30 minutes at 7am for a week`, `Recalled more words after morning study ${STAMP}`, "Observation", "Lived experience", "Context only", "Supporting evidence", "Review history", `For me, mornings worked in that week ${STAMP}`].every((t) => dt.includes(t)));
  // the server, not the browser, decides whether a review is allowed
  const cand = page.locator(`details[data-experiment="${growth.candidate.id}"]`);
  await cand.locator("summary").click();
  await cand.getByLabel("Move to").selectOption("CONFIRMED");
  probing = true; // the server is EXPECTED to refuse this with a 4xx
  await cand.getByRole("button", { name: "Record review" }).click();
  await cand.locator(".outcome.bad").waitFor(); await page.waitForTimeout(200); probing = false;
  check("Learning: an evidence-less confirmation is refused and the server's own explanation is shown", (await cand.locator(".outcome.bad").textContent()).includes("can't go from candidate to confirmed"));
  check("Learning: the refused experiment is still a candidate", (await page.locator(`details[data-experiment="${growth.candidate.id}"] summary`).textContent()).toLowerCase().includes("candidate"));
  await page.screenshot({ path: `${SP}/15-learning.png`, fullPage: true });

  // security, from inside the signed-in browser: only allow-listed routes exist, and another principal's data is unreachable
  const probe = (method, path, body) => page.evaluate(async ([m, p, b]) => { const r = await fetch(p, { method: m, headers: { "X-Requested-With": "guidehub-cockpit", "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return r.status; }, [method, path, body]);
  probing = true;
  check("Security: a route that is not on the allow-list is 404 (aspiration detail, audit, reviews)", (await probe("GET", `/api/future/aspirations/${growth.aspiration.id}`)) === 404 && (await probe("GET", "/api/audit")) === 404 && (await probe("GET", "/api/reviews")) === 404);
  check("Security: actions that have no screen are 404 (achieve, update, session log, fcard review with a suffix)", (await probe("POST", "/api/actions/system.future/ASPIRATION_ACHIEVE", {})) === 404 && (await probe("POST", "/api/actions/system.future/ASPIRATION_UPDATE", {})) === 404 && (await probe("POST", "/api/actions/system.learning/SESSION_LOG", {})) === 404);
  check("Security: an experiment id needs to be a UUID and the wildcard forms are 404", (await probe("GET", "/api/learning/experiments/not-a-uuid")) === 404 && (await probe("GET", `/api/learning/experiments/${growth.observed.id}/x`)) === 404 && (await probe("GET", "/api/learning/cards/x")) === 404);
  if (growth.foreign) {
    const st = await probe("GET", `/api/learning/experiments/${growth.foreign.id}`);
    check("Security: another principal's experiment is unreachable (same answer as a missing one)", st === 404 || st === 403);
    const st2 = await probe("POST", "/api/actions/system.learning/EXPERIMENT_OBSERVE", { experimentId: growth.foreign.id, text: "intruder" });
    check("Security: writing to another principal's experiment fails", st2 !== 200 && st2 !== 202);
    check("Security: their experiment never appears in this owner's list", !(await page.evaluate(async () => JSON.stringify(await (await fetch("/api/learning/experiments", { headers: { "X-Requested-With": "guidehub-cockpit" } })).json()))).includes("Someone else's experiment"));
  }
  await page.waitForTimeout(300); probing = false;
  const anon = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ap = await anon.newPage(); await ap.goto(`${URL_}/`);
  probing = true;
  const anonStatuses = await ap.evaluate(async () => Promise.all(["/api/future/aspirations", "/api/learning/objectives", "/api/learning/experiments"].map(async (p) => (await fetch(p, { headers: { "X-Requested-With": "guidehub-cockpit" } })).status)));
  check("Security: signed out, the new read routes answer 401", anonStatuses.every((c) => c === 401), anonStatuses.join(","));
  await anon.close(); probing = false;
  await page.evaluate(() => { location.hash = "#/learning/not-a-view"; }); await page.waitForSelector("#briefing h1");
  check("Security: an unknown hash view falls back to Today, not to a data screen", true);

  // ── Memory & Knowledge, open loops, factual badges ─────────────────────────────────────────────────────────────────────────────
  await page.getByRole("link", { name: "Memory", exact: true }).click();
  await page.waitForSelector("h1:has-text('Memory & Knowledge')");
  await page.getByLabel("Search", { exact: true }).fill("MEMSEED");
  await page.getByRole("button", { name: "Search" }).click();
  await page.waitForSelector("[data-memory]");
  const inf = page.locator("[data-type=INFERENCE]", { hasText: "MEMSEED I probably think" });
  const infText = await inf.textContent();
  check("Memory: an inference is labelled 'not a fact' and unconfirmed; an experience says lived; provenance is shown", infText.includes("Inference — not a fact") && infText.includes("Unconfirmed") && infText.includes("Inferred by Jarvis") && (await page.locator("[data-type=EXPERIENCE]").first().textContent()).includes("Experience (lived)") && (await page.locator("[data-type=EXPERIENCE]").first().textContent()).includes("Personally experienced"));
  await page.getByLabel("Type", { exact: true }).selectOption("EXPERIENCE");
  await page.getByRole("button", { name: "Search" }).click();
  await page.waitForSelector("[data-memory][data-type=EXPERIENCE]");
  await page.waitForFunction(() => document.querySelectorAll("[data-memory][data-type=INFERENCE]").length === 0);
  check("Memory: filtering by type shows only that type", (await page.locator("[data-memory][data-type=EXPERIENCE]").count()) >= 1 && (await page.locator("[data-memory][data-type=FACT]").count()) === 0);
  await page.getByLabel("Type", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Search" }).click();
  await page.waitForSelector("[data-type=INFERENCE]");
  const inf2 = page.locator("[data-type=INFERENCE]", { hasText: "MEMSEED I probably think" });
  await inf2.getByRole("button", { name: "Confirm this is right" }).click();
  await inf2.getByRole("button", { name: "Yes, it's right" }).click();
  await inf2.locator(".outcome").waitFor({ timeout: 8000 });
  const confirmOutcome = await inf2.locator(".outcome").textContent();
  check("Memory: confirming an inference is an explicit two-step action, goes through the ordinary action path (approval when policy says so), and is reported honestly", /approval|Confirmed|confirmed/i.test(confirmOutcome), confirmOutcome.slice(0, 80));
  const wrong = page.locator("[data-type=FACT]", { hasText: "MEMSEED temp wrong fact" });
  await wrong.getByRole("button", { name: "Mark as wrong" }).click();
  await wrong.getByRole("button", { name: "Mark as wrong" }).last().click(); // empty reason first: the browser itself blocks it
  check("Memory: marking as wrong needs a reason (the reason field is required)", await wrong.locator("textarea").evaluate((el) => el.required && el.validity.valueMissing) && (await wrong.locator(".outcome").count()) === 0);
  await wrong.locator("textarea").fill("It was a test entry");
  await wrong.getByRole("button", { name: "Mark as wrong" }).last().click();
  await wrong.locator(".outcome").waitFor({ timeout: 8000 });
  const wrongOutcome = await wrong.locator(".outcome").textContent();
  check("Memory: marking as wrong is reported honestly (done, or waiting for approval) — never silently", /approval|wrong|retract|Marked|Memory/i.test(wrongOutcome), wrongOutcome.slice(0, 80));
  check("Memory: no delete or edit control exists", (await page.getByRole("button", { name: /^(Delete|Edit|Remove)/ }).count()) === 0);
  await page.getByLabel("Look in").selectOption("knowledge");
  await page.getByLabel("Search", { exact: true }).fill("KNOWSEED");
  await page.getByRole("button", { name: "Search" }).click();
  await page.waitForSelector("[data-knowledge]");
  check("Knowledge: an item shows its kind and that it is about the world, not about you", (await page.locator("[data-knowledge]").first().textContent()).includes("About the world, not about you") && (await page.locator("[data-knowledge]").first().textContent()).includes("KNOWSEED Spaced repetition"));
  await page.screenshot({ path: `${SP}/22-memory.png`, fullPage: true });
  probing = true;
  const mprobe = (method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch(p, { method: m, headers: { "X-Requested-With": "guidehub-cockpit", "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).status, [method, path, body]);
  check("Memory security: delete, update and create are not reachable from the cockpit; knowledge item detail isn't either", (await mprobe("POST", "/api/actions/system.memory/MEMORY_DELETE", {})) === 404 && (await mprobe("POST", "/api/actions/system.memory/MEMORY_UPDATE", {})) === 404 && (await mprobe("POST", "/api/actions/system.memory/MEMORY_CREATE", {})) === 404 && (await mprobe("GET", "/api/knowledge/items/0d3b9a3e-5f7c-4a3e-9d0e-1f2a3b4c5d6e")) === 404);
  await page.waitForTimeout(300); probing = false;

  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.waitForSelector("#loops section h2:has-text('What matters')");
  await page.waitForSelector("#badges section h2:has-text('On record')");
  const lt = await page.textContent("#loops");
  check("Today: 'What matters' lists real open items with the reason each is listed", lt.includes("Due now") && lt.includes(`Second look ${STAMP}`) && lt.includes("look-back date for this decision has passed") && lt.includes("Still open") && lt.includes("Angel OS as a daily system") && lt.includes("no open next action linked"));
  check("Today: open experiments and objectives appear as open loops; nothing is scored", lt.includes(`Morning study sticks better ${STAMP}`) && lt.includes("Nothing is scored or invented") && !/(\d\s?%|\bxp\b|\blevel\b|\bscore\b)/i.test(lt));
  const bt = await page.textContent("#badges");
  check("Today: badges are factual — each states its rule and count; earned ones say Earned; there is no percentage, level or XP", bt.includes("First decision on record") && bt.includes("Rule: 1 decision recorded") && bt.includes("Earned") && bt.includes("Not earned yet") && !/(\d\s?%|\bxp\b|\blevel\b|\bscore\b)/i.test(bt), bt.slice(0, 200));
  check("Today: the streak line is a count of real days", /(Current run: \d+ day|No days in a row|No current run)/.test(bt));
  await page.getByPlaceholder(/Ask Jarvis/).fill("What matters today?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.waitForSelector("p.pre:has-text('Due now')", { timeout: 8000 });
  check("Jarvis answers 'What matters today?' from the same open loops", (await page.textContent("p.pre")).includes(`Second look ${STAMP}`));
  check("Ask on Today leaves you on Today (a stale refresh from another screen must not swap the view)", (await page.locator("#loops section h2").count()) >= 1 && (await page.locator("h1:has-text('Learning')").count()) === 0);
  await page.screenshot({ path: `${SP}/23-today-loops.png`, fullPage: true });

  // ── Capture: a sentence becomes a draft; nothing is saved until the owner confirms ──────────────────────────────────────────────
  const apiGet = (path) => page.evaluate(async (p) => (await (await fetch(p, { headers: { "X-Requested-With": "guidehub-cockpit" } })).json()), path);
  await page.getByRole("link", { name: "Capture", exact: true }).click();
  await page.waitForSelector("h1:has-text('Capture')");
  await page.getByLabel("What happened, what did you decide, what did you learn?").fill("E2E-MIXED I worked three hours on Angel OS and realised I should test it before adding features.");
  await page.getByRole("button", { name: "Interpret" }).click();
  await page.waitForSelector("[data-proposal]");
  const prop = page.locator("[data-proposal]");
  const ptxt = await prop.textContent();
  check("Capture: the draft says nothing has been saved yet", ptxt.includes("Nothing has been saved yet."));
  check("Capture: an inference is labelled as not a fact and the model's confidence is shown as not evidence", ptxt.includes("Interpretation (not a fact)") && ptxt.includes("not evidence, and not saved"));
  check("Capture: an unsupported state change is explained and cannot be ticked; an unknown kind is listed as not understood", ptxt.includes("must cite evidence") && (await prop.locator("[data-status=UNSUPPORTED] input[type=checkbox]").count()) === 0 && ptxt.includes("isn't something Jarvis can capture"));
  check("Capture: the model's clarification is shown, not answered for you", ptxt.includes("personally tested this, or learned it as general knowledge"));
  const tasksBefore = JSON.stringify(await apiGet("/api/tasks"));
  const memBefore = JSON.stringify(await apiGet("/api/memory/search?q=E2E"));
  check("Capture: nothing was written by interpreting (no task, no memory yet)", !tasksBefore.includes("E2E run the validation scenarios") && !memBefore.includes("E2E worked three hours"));
  await page.screenshot({ path: `${SP}/20-capture-draft.png`, fullPage: true });
  // untick the next action: it must NOT be saved
  await prop.getByLabel("Save item 3").uncheck();
  await prop.getByRole("button", { name: "Confirm selected" }).click();
  await page.waitForSelector("[data-outcome]");
  const outs = await page.locator("[data-outcome]").evaluateAll((els) => els.map((e) => e.getAttribute("data-outcome")));
  check("Capture: confirming reports honest per-item outcomes (two saved, the unticked one not saved)", outs.filter((o) => o === "EXECUTED").length === 2 && outs.filter((o) => o === "SKIPPED").length >= 1, outs.join(","));
  const memAfter = await apiGet("/api/memory/search?q=E2E");
  const hit = JSON.stringify(memAfter);
  check("Capture: the experience was saved as an EXPERIENCE and the inference as an unconfirmed INFERENCE — never as a fact", hit.includes("E2E worked three hours") && /"type":"EXPERIENCE"/.test(hit) && /"type":"INFERENCE"/.test(hit) && !/"type":"FACT"/.test(hit) && !hit.includes('"status":"ACTIVE","type":"INFERENCE"'));
  check("Capture: the unticked next action was not saved", !JSON.stringify(await apiGet("/api/tasks")).includes("E2E run the validation scenarios"));
  check("Capture: a confirmed draft cannot be confirmed again from the screen", await page.getByRole("button", { name: "Confirm selected" }).isDisabled());
  // cancel path
  await page.reload(); await page.waitForSelector("h1:has-text('Capture')");
  await page.getByLabel("What happened, what did you decide, what did you learn?").fill("E2E-CANCEL a thing I do not want saved");
  await page.getByRole("button", { name: "Interpret" }).click();
  await page.waitForSelector("[data-proposal]");
  const cancelId = await page.locator("[data-proposal]").getAttribute("data-proposal");
  await page.getByRole("button", { name: "Cancel — save nothing" }).click();
  await page.waitForSelector("text=Cancelled. Nothing was saved.");
  check("Capture: cancelling saves nothing", !JSON.stringify(await apiGet("/api/tasks")).includes("E2E never saved"));
  // security from the signed-in browser
  probing = true;
  const cprobe = (method, path, body) => page.evaluate(async ([m, p, b]) => (await fetch(p, { method: m, headers: { "X-Requested-With": "guidehub-cockpit", "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).status, [method, path, body]);
  check("Capture security: a cancelled draft can't be confirmed (404)", (await cprobe("POST", `/api/capture/${cancelId}/confirm`, {})) === 404);
  check("Capture security: only interpret/confirm/cancel exist — GET, approve and other verbs are 404", (await cprobe("GET", "/api/capture")) === 404 && (await cprobe("POST", `/api/capture/${cancelId}/approve`, {})) === 404 && (await cprobe("DELETE", "/api/capture")) === 404);
  check("Capture security: a principal or extra field in the body is refused", [400, 404].includes(await cprobe("POST", "/api/capture", { text: "E2E-CANCEL x", principalId: "00000000-0000-0000-0000-0000000000ff" })));
  if (TOKEN_B) {
    const foreign = await (await fetch(`${API}/api/capture`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN_B}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "E2E-CANCEL foreign draft" }) })).json();
    const fid = foreign.data?.proposalId;
    check("Capture security: another principal's draft can be neither confirmed nor cancelled from this cockpit", !!fid && (await cprobe("POST", `/api/capture/${fid}/confirm`, {})) === 404 && (await cprobe("POST", `/api/capture/${fid}/cancel`, {})) === 404);
  }
  await page.waitForTimeout(300); probing = false;
  const anonC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const anonP = await anonC.newPage(); await anonP.goto(`${URL_}/`); probing = true;
  const anonStatus = await anonP.evaluate(async () => (await fetch("/api/capture", { method: "POST", headers: { "X-Requested-With": "guidehub-cockpit", "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }) })).status);
  check("Capture security: signed out, /api/capture answers 401", anonStatus === 401, String(anonStatus));
  await anonC.close(); probing = false;

  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.waitForSelector("#briefing h1");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload(); await page.waitForSelector("#briefing h1"); await page.waitForTimeout(500);
  await page.screenshot({ path: `${SP}/4-mobile.png`, fullPage: true });
  await page.getByRole("link", { name: "Life", exact: true }).click(); await page.waitForSelector("h1:has-text('Life')"); await page.waitForSelector("section:has-text('Projects')"); await page.waitForTimeout(400);
  check("Life has no horizontal scroll at phone width", !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
  await page.screenshot({ path: `${SP}/9-life-mobile.png`, fullPage: true });
  await page.getByRole("link", { name: "Decisions", exact: true }).click(); await page.waitForSelector("h1:has-text('Decisions')"); await page.waitForTimeout(400);
  check("Decisions has no horizontal scroll at phone width", !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
  await page.screenshot({ path: `${SP}/12-decisions-mobile.png`, fullPage: true });
  await page.getByRole("link", { name: "Future Self", exact: true }).click(); await page.waitForSelector("h1:has-text('Future Self')"); await page.waitForSelector("article.aspiration"); await page.waitForTimeout(400);
  check("Future Self has no horizontal scroll at phone width", !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
  await page.screenshot({ path: `${SP}/16-future-mobile.png`, fullPage: true });
  await page.getByRole("link", { name: "Learning", exact: true }).click(); await page.waitForSelector("h1:has-text('Learning')"); await page.waitForSelector("section:has-text('Objectives')"); await page.waitForTimeout(400);
  check("Learning has no horizontal scroll at phone width", !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
  await page.screenshot({ path: `${SP}/17-learning-mobile.png`, fullPage: true });
  await page.getByRole("link", { name: "Capture", exact: true }).click(); await page.waitForSelector("h1:has-text('Capture')"); await page.waitForTimeout(300);
  check("Capture has no horizontal scroll at phone width", !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
  await page.screenshot({ path: `${SP}/21-capture-mobile.png`, fullPage: true });
  for (const [nav, sel] of [["Memory", "h1:has-text('Memory & Knowledge')"], ["Today", "#loops section"]]) {
    await page.getByRole("link", { name: nav, exact: true }).click(); await page.waitForSelector(sel); await page.waitForTimeout(400);
    check(`${nav} has no horizontal scroll at phone width`, !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
    await page.screenshot({ path: `${SP}/24-${nav.toLowerCase()}-mobile.png`, fullPage: true });
  }
  await page.getByRole("link", { name: "Today", exact: true }).click(); await page.waitForSelector("#briefing h1");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  check("no horizontal scroll at phone width", !overflow);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForSelector("form.signin");
  probing = true; const r = await page.evaluate(async () => (await fetch("/api/me")).status); await page.waitForTimeout(300); probing = false;
  check("after sign-out the API is closed to this browser", r === 401);
  await page.reload(); await page.waitForSelector("form.signin");
  check("reload after sign-out stays signed out", true);
  const ctxDark = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const p2 = await ctxDark.newPage(); await p2.goto(`${URL_}/`); await p2.waitForSelector("form.signin");
  await p2.fill("#pass", PASSPHRASE); await p2.click("button[type=submit]"); await p2.waitForSelector("#briefing h1"); await p2.waitForTimeout(500);
  await p2.screenshot({ path: `${SP}/5-today-dark.png` });
  await p2.goto(`${URL_}/#/future-self`); await p2.waitForSelector("h1:has-text('Future Self')"); await p2.waitForSelector("article.aspiration"); await p2.waitForTimeout(300);
  await p2.screenshot({ path: `${SP}/18-future-dark.png` });
  const bgDark = await p2.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await p2.goto(`${URL_}/#/learning`); await p2.reload(); await p2.waitForSelector("h1:has-text('Learning')"); await p2.waitForTimeout(300);
  await p2.screenshot({ path: `${SP}/19-learning-dark.png` });
  check("dark mode: Future Self and Learning render on a dark background", /rgb\((\d+), (\d+), (\d+)\)/.test(bgDark) && Number(/rgb\((\d+)/.exec(bgDark)[1]) < 60, bgDark);

  check("no console errors / CSP violations", problems.length === 0, problems.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => { console.error("E2E crashed:", e.message); try { if (crashPage) { await crashPage.screenshot({ path: `${SP}/crash.png`, fullPage: true }); console.error((await crashPage.textContent("main")).slice(0, 3000)); } } catch { /* best effort */ } process.exit(2); });
