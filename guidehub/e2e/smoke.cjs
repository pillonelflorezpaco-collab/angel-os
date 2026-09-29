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
require("node:fs").mkdirSync(SP, { recursive: true });

async function act(skillAction, body) {
  const r = await fetch(`${API}/api/actions/${skillAction}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  await act("system.future/METRIC_CREATE", { aspirationId: asp.id, name: "km", unit: "km", baseline: 0, target: 10 });
  await act("system.decisions/DECISION_RECORD", { title: `Second look ${stamp}`, decision: "Hire a contractor", expected: "shipped sooner", reviewAt: "2020-03-01T00:00:00.000Z" }); // OLDER than the next one, so the Today flow (newest first) reviews that one and this one stays due for the Decisions screen
  await act("system.decisions/DECISION_RECORD", { title: `Adopt a cockpit ${stamp}`, decision: "Build it", expected: "faster reviews", reviewAt: "2020-01-01T00:00:00.000Z" });
  const topic = await act("system.learning/TOPIC_CREATE", { title: `Spanish ${stamp}` });
  await act("system.learning/CARD_CREATE", { topicId: topic.id, prompt: "Hola means?", answer: "Hello" });
  await act("system.memory/MEMORY_CREATE", { type: "FACT", content: `I sleep badly after coffee ${stamp}`, source: "e2e" });
  await act("system.tasks/CREATE_TASK", { title: `Try decaf ${stamp}` });
  const person = await act("system.life/PERSON_CREATE", { name: `Temp person ${stamp}` });
  await act("system.life/PERSON_DELETE", { personId: person.id }); // SENSITIVE: waits for approval in the cockpit
}
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); };

(async () => {
  if (!TOKEN || !PASSPHRASE || !process.env.CHROMIUM_PATH) { console.error("Set GUIDEHUB_E2E_API_TOKEN, GUIDEHUB_E2E_PASSPHRASE and CHROMIUM_PATH (see the header)."); process.exit(2); }
  await seed();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  const page = await ctx.newPage();
  const problems = []; let probing = false;
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !(probing && m.text().includes("401"))) problems.push(`${m.type()}: ${m.text()} @${m.location().url}`); });
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
  check("aspiration with no readings says 'No evidence yet' (not 0%)", (await page.textContent("#briefing")).includes("No evidence yet") && !(await page.textContent("#briefing")).includes("0% by recorded"));

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
  await page.waitForSelector("text=You expected");
  await page.waitForSelector("text=What happened");
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

  check("no console errors / CSP violations", problems.length === 0, problems.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("E2E crashed:", e.message); process.exit(2); });
