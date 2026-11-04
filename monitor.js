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

// Re-run the class search. A full page reload loses PeopleSoft's search results,
// so instead we re-trigger the search in place. PeopleSoft's keyword search submits
// when you press Enter in the box, which is the most reliable path, so we try that
// first, then fall back to clicking a magnifying-glass / search button. We scan
// every frame since the content lives in nested iframes.
export async function clickSearch(page) {
  // 1) Press Enter in the visible keyword box. We can't use input[type="text"]
  //    alone — PeopleSoft inputs often have NO type attribute (so they default to
  //    text but don't match [type=text]). Enumerate real matches and pick a
  //    visible, editable one rather than blindly taking .first() (often hidden).
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
          await el.click({ timeout: 3000 });
          await el.press("Enter");
          return "pressed Enter in keyword box";
        }
      } catch {
        // not the right input — keep scanning
      }
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

  // 3) Nothing matched — dump the page's controls so we can target the real one.
  await dumpControls(page);
  return null;
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
