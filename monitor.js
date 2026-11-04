import { chromium } from "playwright";
import readline from "node:readline";
import { execFile } from "node:child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const URL =
  "https://bcsweb.is.berkeley.edu/psc/bcsprd/EMPLOYEE/SA/c/SSR_STUDENT_FL.SSR_MD_SP_FL.GBL?Action=U&MD=Y&GMenu=SSR_STUDENT_FL&GComp=SSR_START_PAGE_FL&GPage=SSR_START_PAGE_FL&scname=CS_SSR_MANAGE_CLASSES_NAV&AJAXTransfer=y&ICAJAXTrf=true&ICMDListSlideout=true&backTo=academics";

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const USER_DATA_DIR = "./.browser-profile"; // persists login between runs

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleString();
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// macOS desktop notification + sound
function notify(title, message) {
  const script = `display notification ${JSON.stringify(
    message
  )} with title ${JSON.stringify(title)} sound name "Glass"`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) log(`(notification failed: ${err.message})`);
  });
  // Also say it out loud + terminal bell so it's hard to miss.
  execFile("say", [message], () => {});
  process.stdout.write("\u0007");
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

// Re-run the class search by clicking the blue search (magnifying-glass) button.
// A full page reload loses PeopleSoft's search results, so instead we trigger the
// search again in place. We scan every frame and try a few selectors, since the
// button's exact markup isn't guaranteed. Falls back to pressing Enter in the
// search box if no button is found.
export async function clickSearch(page) {
  const buttonSelectors = [
    'a[aria-label*="search" i]',
    'button[aria-label*="search" i]',
    '[title*="search" i][role="button"]',
    'a[title*="search" i]',
    'button[title*="search" i]',
    'input[type="button"][value*="search" i]',
    'input[type="submit"][value*="search" i]',
    '[id*="SEARCH_BTN" i]',
    '[id*="SRCH_BTN" i]',
  ];

  for (const frame of page.frames()) {
    for (const sel of buttonSelectors) {
      const loc = frame.locator(sel).first();
      try {
        if (await loc.isVisible({ timeout: 300 })) {
          await loc.click({ timeout: 5000 });
          return `clicked ${sel}`;
        }
      } catch {
        // selector not present / not clickable in this frame — keep trying
      }
    }
  }

  // Fallback: pressing Enter inside the search box re-runs the search too.
  for (const frame of page.frames()) {
    const box = frame
      .locator('input[type="search"], [role="searchbox"], input[type="text"]')
      .first();
    try {
      if (await box.isVisible({ timeout: 300 })) {
        await box.press("Enter");
        return "pressed Enter in search box";
      }
    } catch {
      // keep trying other frames
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  log("Launching browser…");
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  });

  const page = context.pages()[0] || (await context.newPage());

  log("Opening the class page. Logging in is up to you.");
  await page.goto(URL, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("\n==============================================================");
  console.log(" 1. Log in and navigate until the  Open: <number>  is visible");
  console.log(" 2. Then come back here and press ENTER to start monitoring");
  console.log("==============================================================\n");
  await waitForEnter("Press ENTER once the Open count is on screen… ");

  let current = await readOpenValue(page);
  if (current === null) {
    console.log(
      "\n⚠️  Couldn't find 'Open:' on the page right now.\n" +
        "    Make sure the number is visible, then press ENTER to try again."
    );
    await waitForEnter("Press ENTER to retry… ");
    current = await readOpenValue(page);
  }

  if (current === null) {
    log("Still can't read the Open value. Exiting so you can check the page.");
    await context.close();
    process.exit(1);
  }

  log(`Baseline Open value: ${current}. Checking every 5 minutes.`);
  notify("Monitoring started", `Open is currently ${current}`);

  // ───────────────────────────── Poll loop ─────────────────────────────
  while (true) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));

    const how = await clickSearch(page);
    if (how === null) {
      log("Couldn't find the search button this cycle. Will retry next cycle.");
      continue;
    }
    log(`Re-ran search (${how}).`);

    // Give PeopleSoft's async rendering a moment to settle after the search.
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const value = await readOpenValue(page);

    if (value === null) {
      log("Could not read Open value this cycle (session may have expired?).");
      notify(
        "Monitor can't read the page",
        "The Open count wasn't found — you may need to log in again."
      );
      continue;
    }

    if (value !== current) {
      log(`⚡ CHANGED: Open went from ${current} → ${value}`);
      notify("Open count changed!", `${current} → ${value}`);
      current = value;
    } else {
      log(`No change. Open = ${value}`);
    }
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
