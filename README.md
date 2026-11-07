# Berkeley class seat watcher

A small Node.js script that watches UC Berkeley class enrollment pages and pings
your phone the moment a seat opens up (or the waitlist count changes).

It opens a real browser, you log in once by hand, and then every minute it
re-runs your class searches, reads the **Open** and **Waitlist** numbers, and
notifies you when anything changes — on your Mac *and* on your phone via a
Telegram bot.

---

## How it works

It's one file, [`monitor.js`](monitor.js) (~460 lines). Here are the pieces:

**1. Browser automation — Playwright.**
The script launches a real Chromium browser with
`chromium.launchPersistentContext`. "Persistent" is the key: it saves the
browser profile to `.browser-profile/`, so your Berkeley login sticks around
between runs — you only log in once. It opens one tab per class, all sharing
that single login.

**2. Reading the page — iframes.**
Berkeley's site (PeopleSoft) buries its content inside nested `<iframe>`s, so you
can't just read the page text. The script loops over every frame
(`page.frames()`) and pulls text out of each one. That's `readAllSections`.

**3. Refreshing without losing results.**
A normal page reload wipes out the search results, so instead the script
re-triggers the search in place — it finds the keyword box and presses Enter,
which is how PeopleSoft re-runs a search. (Finding that box is fiddly: the inputs
have no `type` attribute, so a naive `input[type=text]` selector misses them.)

**4. Parsing — the clever bit.**
A single search for any course (say `compsci 189` or `physics 5b`) can return
*several* sections — a lecture plus its discussion/lab sections.
`parseOpenSections` splits the page text into per-section blocks: each starts
with a course header (e.g. `COMPSCI 189:`), followed by a component line
(`LEC 001 #26152`), an `Open: N`, and a waitlist count. The class number
(`#26152`) is a unique ID, so when two searches overlap and show the same
section, a `Map` keyed by that number automatically de-duplicates them. An
`EXCLUDE` list drops any unrelated result a search happens to pull in.

**5. Change detection + alerts.**
It keeps a baseline snapshot of every section's Open/Waitlist. Each cycle it
takes a fresh snapshot and compares. If Open or Waitlist moved, it fires a
notification: a macOS popup + spoken alert, and a push to your phone via a
**Telegram bot** (a simple HTTP POST to Telegram's API — Telegram because it's
free and, unlike some alternatives, not rate-limited on shared campus WiFi).

**6. Staying alive with the lid closed.**
Run it under `caffeinate` (see below) to keep the Mac awake so it keeps polling
even when the laptop is closed.

---

## Setup

Requires [Node.js](https://nodejs.org) (v18+). Then, in the project folder:

```bash
npm install
npx playwright install chromium
```

### Pick your classes

Open [`monitor.js`](monitor.js) and edit the `CLASSES` list near the top. Put in
**any** courses you want to watch — any subject, any number — typed exactly as
you'd type them into the Class Search box. For example:

```js
const CLASSES = ["compsci 189", "math 54", "physics 5b"];
```

It opens one browser tab per entry, so add as many as you like. If a search pulls
in a course you *don't* want to watch, add it to `EXCLUDE`:

```js
const EXCLUDE = ["physics 110a"]; // e.g. drop a course a broad search returns
```

### Set up phone notifications (Telegram)

1. In Telegram, message **@BotFather**, send `/newbot`, and follow the prompts.
   It gives you a **bot token** (looks like `123456:ABC-DEF...`).
2. Message **@userinfobot** to get your numeric **chat ID**.
3. Open a chat with *your* new bot and tap **Start** (the bot can't message you
   until you do). Anyone else who wants alerts must also tap Start on it.

You pass the token and chat ID as environment variables when you run it (so they
stay out of the code). For multiple phones, comma-separate the chat IDs.

---

## Run it

```bash
TELEGRAM_TOKEN="your-bot-token" TELEGRAM_CHAT_ID="your-chat-id" node monitor.js
```

Then:

1. A browser window opens — **log in to Berkeley** (just once; all tabs share it).
2. In each tab, run one of your searches so the results are on screen.
3. Come back to the terminal and press **ENTER**.

It prints the starting Open/Waitlist for every section and then checks every
minute, alerting you on any change.

To keep it running with the lid closed, launch it under `caffeinate`:

```bash
caffeinate -dis node monitor.js
```

(You may also need macOS → System Settings to allow running with the lid shut.)

Leave the Telegram variables off and it still works — you just get Mac
notifications only.
