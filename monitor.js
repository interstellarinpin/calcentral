import { chromium } from "playwright";
import readline from "node:readline";
import { execFile } from "node:child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const URL =
  "https://bcsweb.is.berkeley.edu/psc/bcsprd/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_MD_SP_FL.GBL?Action=U&MD=Y&GMenu=SSR_STUDENT_FL&GComp=SSR_START_PAGE_FL&GPage=SSR_START_PAGE_FL&scname=CS_SSR_MANAGE_CLASSES_NAV&AJAXTransfer=y&ICAJAXTrf=true&ICMDListSlideout=true&backTo=academics";

// The classes to watch — one tab each, all in one browser with a single login.
// Type them exactly as you'd type into the Class Search box. Add/remove freely.
const CLASSES = ["physics 5b", "physics 5bl", "physics 89"];

// Sections to ignore even if a search returns them (searches sometimes pull in
// unrelated courses). Matched loosely against each section's label, so
// "physics 110a" drops "PHYSICS 110A: …" no matter the component/number.
const EXCLUDE = ["physics 110a"];

const INTERVAL_MS = 1 * 60 * 1000; // 1 minute
const USER_DATA_DIR = "./.browser-profile"; // persists login between runs

// Also push alerts to one or more phones via a Telegram bot. Set both env vars:
//   TELEGRAM_TOKEN="123456:ABC..."     (from @BotFather)
//   TELEGRAM_CHAT_ID="12345678"        (your chat id, from @userinfobot)
// For multiple phones, comma-separate the IDs: TELEGRAM_CHAT_ID="111,222"
// Each recipient must have tapped Start on the bot first. Leave either unset to
// skip Telegram (Mac notification still fires).
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString();
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// macOS desktop notification + sound. Pass { push: false } for local-only
// messages (startup summary, errors) so they DON'T ping anyone's phone —
// Telegram should only fire on real seat/waitlist changes.
function notify(title, message, { push = true } = {}) {
  const script = `display notification ${JSON.stringify(
    message
  )} with title ${JSON.stringify(title)} sound name "Glass"`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) log(`(notification failed: ${err.message})`);
  });
  // Also say it out loud + terminal bell so it's hard to miss.
  execFile("say", [message], () => {});
  process.stdout.write("\u0007");
  // And push to your (and your friend's) phone via Telegram, if configured —
  // but only for real changes, not startup/error noise.
  if (push) pushTelegram(`${title} — ${message}`);
}

// Send a Telegram message via your bot. No-op unless both env vars are set.
// Telegram isn't IP-rate-limited like ntfy, so it works on shared campus WiFi.
async function pushTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const ids = TELEGRAM_CHAT_ID.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: id, text }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log(`(Telegram push to ${id} failed: HTTP ${res.status} ${body.slice(0, 150)})`);
      }
    } catch (e) {
      log(`(Telegram push to ${id} error: ${e.message})`);
    }
  }
}

function waitForEnter(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

// Scan the main page AND every iframe for "Open: <number>".
// PeopleSoft often renders content inside nested frames, so we check them all.
export async function readOpenValue(page) {
  const frames = page.frames();
  for (const frame of frames) {
    let text;
    try {
      text = await frame.evaluate(() => document.body?.innerText || "");
    } catch {
      continue; // frame may have navigated away
    }
    const match = text.match(/Open:\s*(\d+)/i);
    if (match) return match[1];
  }
  return null;
}

// Parse EVERY section on a results page from its text. A search like
// "physics 5b" returns multiple sections (PHYSICS 5B plus several 5BL labs),
// each with its own "Open: N". We split the text into per-section blocks that
// start at a course header ("PHYSICS 5B: …", "PHYSICS 5BL: …") and pull out the
// section component ("LEC 001 #22702") and its Open count. The class number
// (#22702) is a stable unique key per section.
export function parseOpenSections(text) {
  const headerRe = /^([A-Z][A-Z&]*(?:\s+[A-Z&]+)*\s+\d+[A-Z]*):\s*(.+)$/;
  const compRe = /^(LEC|LAB|DIS|SEM|STU|FLD|IND|REC|GRP|TUT|WOR|COL)\s+(\d+)\s+#(\d+)/;
  const openRe = /Open:\s*(\d+)/i;
  // Waitlist, written various ways by PeopleSoft: "Waitlist: 5", "Wait List 5",
  // "Waitlisted: 10 / 10" (people waiting / waitlist capacity). We grab both
  // numbers when present and keep them as "10 / 10", so a change in EITHER
  // (e.g. 10 / 10 -> 9 / 10 when someone drops) counts as a change.
  const waitRe = /wait\s*-?\s*list(?:ed)?(?:\s+total)?[:\s]+(\d+)(?:\s*\/\s*(\d+))?/i;

  const sections = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(headerRe);
    if (h) {
      cur = { course: h[1].replace(/\s+/g, " "), comp: null, num: null, open: null, wait: null };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    const c = line.match(compRe);
    if (c && !cur.comp) {
      cur.comp = `${c[1]} ${c[2]}`;
      cur.num = c[3];
      continue;
    }
    const o = line.match(openRe);
    if (o && cur.open === null) {
      cur.open = o[1];
      continue;
    }
    const w = line.match(waitRe);
    if (w && cur.wait === null) cur.wait = w[2] ? `${w[1]} / ${w[2]}` : w[1];
  }

  return sections
    .filter((s) => s.open !== null)
    .map((s) => ({
      id: s.num || `${s.course} ${s.comp || ""}`.trim(),
      label: [s.course, s.comp, s.num ? `#${s.num}` : ""].filter(Boolean).join(" "),
      open: s.open,
      wait: s.wait, // may be null if the page didn't show a waitlist count
    }));
}

// True if a section matches the EXCLUDE list (e.g. physics 110A), so searches
// that pull in unrelated courses don't get watched.
export function isExcluded(section) {
  const label = normId(section.label);
  return EXCLUDE.some((e) => label.includes(normId(e)));
}

// Read every section (across all frames) of a results page into a Map keyed by
// the stable class number, so overlapping tabs (e.g. "physics 5b" and
// "physics 5bl" both show the labs) naturally dedupe.
export async function readAllSections(page) {
  const map = new Map();
  for (const frame of page.frames()) {
    let text;
    try {
      text = await frame.evaluate(() => document.body?.innerText || "");
    } catch {
      continue;
    }
    for (const s of parseOpenSections(text)) {
      if (isExcluded(s)) continue;
      map.set(s.id, s);
    }
  }
  return map;
}

// Normalize a class id for loose matching: "compsci 189" -> "COMPSCI189",
// so it matches the page's "COMPSCI 189: Introduction To Machine Learning".
export function normId(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Find which open tab is showing a given class, and read its Open count.
// We match by the class name appearing in the page text, so the label always
// follows the actual tab content — no reliance on tab order. Returns the page
// and value, or null if no tab currently shows that class with an Open count.
export async function findClassTab(pages, query) {
  const want = normId(query);
  for (const page of pages) {
    for (const frame of page.frames()) {
      let text;
      try {
        text = await frame.evaluate(() => document.body?.innerText || "");
      } catch {
        continue;
      }
      if (normId(text).includes(want)) {
        const m = text.match(/Open:\s*(\d+)/i);
        if (m) return { page, value: m[1] };
      }
    }
  }
  return null;
}

// Re-run the class search. A full page reload loses PeopleSoft's search results,
// so instead we re-trigger the search in place. PeopleSoft's keyword search submits
// when you press Enter in the box, which is the most reliable path, so we try that
// first, then fall back to clicking a magnifying-glass / search button. We scan
// every frame since the content lives in nested iframes.
export async function clickSearch(page) {
  // 1) Press Enter in the real class-search keyword box. Two gotchas:
  //    (a) PeopleSoft inputs often have NO type attribute, so they don't match
  //        input[type=text]; and
  //    (b) the page ALSO has a "Filter Subjects" box in the left sidebar — we must
  //        NOT type/Enter into that by mistake (that's what was flashing).
  //    So we skip any filter/subject field and PREFER the input that already holds
  //    the query text (the keyword box keeps "physics 5b" in it across refreshes).
  const editableInputs =
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="image"])';
  const looksLikeFilter = (s) => /filter|subject/i.test(s || "");

  const candidates = [];
  for (const frame of page.frames()) {
    let inputs;
    try {
      inputs = frame.locator(editableInputs);
    } catch {
      continue;
    }
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = inputs.nth(i);
      try {
        if (!(await el.isVisible()) || !(await el.isEditable())) continue;
        const attrs =
          ((await el.getAttribute("placeholder")) || "") + " " +
          ((await el.getAttribute("aria-label")) || "") + " " +
          ((await el.getAttribute("id")) || "") + " " +
          ((await el.getAttribute("name")) || "");
        if (looksLikeFilter(attrs)) continue; // never the Filter Subjects box
        const value = (await el.inputValue().catch(() => "")) || "";
        candidates.push({ el, value });
      } catch {
        // not usable — keep scanning
      }
    }
  }
  // Prefer the box that already holds the search text; else the first candidate.
  const target = candidates.find((c) => c.value.trim()) || candidates[0];
  if (target) {
    try {
      await target.el.click({ timeout: 3000 });
      await target.el.press("Enter");
      return target.value.trim()
        ? `pressed Enter in keyword box ("${target.value.trim()}")`
        : "pressed Enter in keyword box";
    } catch {
      // fall through to the button path below
    }
  }

  // 2) Fall back to clicking a search button / magnifier across all frames.
  const buttonSelectors = [
    '[aria-label*="search" i]',
    '[title*="search" i]',
    '[id*="SEARCH_BTN" i]',
    '[id*="SRCH_BTN" i]',
    '[id*="SEARCH" i][role="button"]',
    'button[class*="search" i]',
    'a[class*="search" i]',
    'button:has(svg)',
  ];
  for (const frame of page.frames()) {
    for (const sel of buttonSelectors) {
      let all;
      try {
        all = frame.locator(sel);
      } catch {
        continue;
      }
      const n = await all.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = all.nth(i);
        try {
          if (await el.isVisible()) {
            await el.scrollIntoViewIfNeeded().catch(() => {});
            await el.click({ timeout: 4000 });
            return `clicked ${sel}`;
          }
        } catch {
          // keep trying
        }
      }
    }
  }

  // 3) Nothing matched this cycle (usually the page was mid-render). Stay quiet
  //    and let the caller decide whether to dump diagnostics after repeated misses.
  return null;
}

// Type a class name into the keyword box and submit, so the script (not the
// user) controls which class lands in which tab. Returns true if it searched.
export async function searchFor(page, query) {
  const editableInputs =
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="image"])';
  for (const frame of page.frames()) {
    let inputs;
    try {
      inputs = frame.locator(editableInputs);
    } catch {
      continue;
    }
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = inputs.nth(i);
      try {
        if ((await el.isVisible()) && (await el.isEditable())) {
          await el.fill(query);
          await el.press("Enter");
          return true;
        }
      } catch {
        // not the keyword box — keep scanning
      }
    }
  }
  return false;
}

// Diagnostic: list the inputs/buttons/links in every frame so we can identify
// the real search control when the heuristics above miss.
async function dumpControls(page) {
  log("── diagnostic: controls found on the page ──");
  for (const frame of page.frames()) {
    let items;
    try {
      items = await frame.evaluate(() => {
        const out = [];
        const els = document.querySelectorAll("input, button, a[onclick], a[href], [role='button']");
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // skip hidden
          out.push({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type") || "",
            id: el.id || "",
            cls: (el.className || "").toString().slice(0, 60),
            aria: el.getAttribute("aria-label") || "",
            title: el.getAttribute("title") || "",
            text: (el.innerText || el.value || "").trim().slice(0, 40),
          });
        }
        return out.slice(0, 40);
      });
    } catch {
      continue;
    }
    if (!items.length) continue;
    log(`  frame: ${frame.url().slice(0, 80)}`);
    for (const it of items) {
      log(
        `    <${it.tag}${it.type ? " type=" + it.type : ""}>` +
          ` id="${it.id}" aria="${it.aria}" title="${it.title}"` +
          ` class="${it.cls}" text="${it.text}"`
      );
    }
  }
  log("── end diagnostic — paste these lines to me if the search still won't trigger ──");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  if (CLASSES.length === 0) {
    log("No classes configured. Add some to the CLASSES list at the top.");
    process.exit(1);
  }

  log("Launching browser…");
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });

  // Open one tab per class up front (login is shared across all of them).
  // We don't auto-navigate to the search box because PeopleSoft doesn't land
  // there reliably — you search each class yourself, then we match each tab to
  // its class by reading the page, so labels are always correct.
  const tabs = [];
  for (let i = 0; i < CLASSES.length; i++) {
    const page = i === 0 ? context.pages()[0] || (await context.newPage()) : await context.newPage();
    await page.goto(URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.bringToFront().catch(() => {});
    tabs.push(page);
  }

  console.log("\n==============================================================");
  console.log(` Watching searches: ${CLASSES.join(", ")}`);
  console.log(` I opened ${CLASSES.length} tab(s) in the browser.`);
  console.log(" 1. Log in (just once — all tabs share it)");
  console.log(" 2. In the tabs, run ONE of these searches each:");
  for (const c of CLASSES) console.log(`       • ${c}`);
  console.log("    (so the results with their Open counts are on screen)");
  console.log(" 3. Come back here and press ENTER");
  console.log(" (Tab order doesn't matter — I read every section on each page.)");
  console.log("==============================================================\n");
  await waitForEnter("Press ENTER once every search's results are on screen… ");

  // Read every section across all tabs into one map (class number -> section),
  // deduped so overlapping searches don't double-count.
  async function snapshot() {
    const all = new Map();
    for (const page of tabs) {
      const secs = await readAllSections(page);
      for (const [id, s] of secs) all.set(id, s);
    }
    return all;
  }

  let baseline = await snapshot();
  if (baseline.size === 0) {
    console.log(
      "\n⚠️  Couldn't read any sections. Make sure each search's results are\n" +
        "    visible (with their Open counts), then press ENTER to retry."
    );
    await waitForEnter("Press ENTER to retry… ");
    baseline = await snapshot();
  }

  if (baseline.size === 0) {
    log("Still no sections readable. Exiting so you can check the page.");
    await context.close();
    process.exit(1);
  }

  const wl = (s) => (s.wait === null ? "n/a" : s.wait);
  log(`Monitoring ${baseline.size} section(s) every minute:`);
  for (const s of baseline.values())
    log(`  • ${s.label}: Open = ${s.open}, Waitlist = ${wl(s)}`);
  notify(
    "Monitoring started",
    [...baseline.values()].map((s) => `${s.label}: Open ${s.open}, WL ${wl(s)}`).join("\n"),
    { push: false } // local only — don't ping phones just because you restarted
  );

  // ───────────────────────────── Poll loop ─────────────────────────────
  // A tab occasionally can't be re-searched for one cycle (page mid-render).
  // That's harmless and self-corrects, so we just log a one-liner. Only if a tab
  // misses several cycles in a row do we dump its controls once, to help debug.
  const DUMP_AFTER = 3;
  const searchFails = new Map();
  while (true) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));

    // Re-run every tab's search, then read a fresh snapshot of all sections.
    let searched = 0;
    const methods = new Set();
    for (const page of tabs) {
      const how = await clickSearch(page);
      if (how === null) {
        const n = (searchFails.get(page) || 0) + 1;
        searchFails.set(page, n);
        log(`Couldn't re-run a search this cycle (miss ${n}); retrying next minute.`);
        if (n === DUMP_AFTER) {
          log(`A tab has missed ${n} cycles in a row — dumping its controls once:`);
          await dumpControls(page);
        }
        continue; // others may still work
      }
      searched++;
      methods.add(how);
      searchFails.set(page, 0); // recovered — reset its miss counter
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    // Proof it actually re-triggered the search this cycle (not reading a stale page).
    log(
      `Re-ran the search on ${searched}/${tabs.length} tab(s)` +
        (methods.size ? ` (${[...methods].join("; ")})` : "") +
        "."
    );

    const now = await snapshot();

    if (now.size === 0) {
      log("Could not read any sections this cycle (session may have expired?).");
      notify(
        "Monitor can't read the page",
        "No Open counts found — you may need to log in again.",
        { push: false } // local only — a login hiccup isn't your friend's problem
      );
      continue;
    }

    let anyChange = false;
    for (const [id, s] of now) {
      const prev = baseline.get(id);
      if (!prev) {
        log(`➕ New section appeared: ${s.label}: Open = ${s.open}, Waitlist = ${wl(s)}`);
        baseline.set(id, s);
        continue;
      }
      const openChanged = s.open !== prev.open;
      const waitChanged = s.wait !== prev.wait;
      if (openChanged || waitChanged) {
        anyChange = true;
        const parts = [];
        if (openChanged) parts.push(`Open ${prev.open} → ${s.open}`);
        if (waitChanged) parts.push(`Waitlist ${wl(prev)} → ${wl(s)}`);
        const detail = parts.join("\n");
        log(`⚡ CHANGED: ${s.label}: ${parts.join(", ")}`);
        notify(`${s.label} — ${openChanged ? "seats changed!" : "waitlist changed"}`, detail);
        baseline.set(id, s);
      }
    }
    if (!anyChange) log(`No change across ${now.size} section(s).`);
  }
}

// Only launch the monitor when run directly (`node monitor.js`),
// so the helpers above can be imported by tests without side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
