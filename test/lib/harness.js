/*
  test/lib/harness.js — the shared rig.

  Every suite here drives the real pages over the real bridge in a real
  browser. There are no unit tests of the arithmetic on purpose: the bugs this
  project actually produces are about what ends up on a screen or in a
  loudspeaker, and they survive reasoning that looks correct. Several of the
  checks in these files were written to confirm something I was sure of and
  failed.

  A suite looks like:

      const { suite } = require("./lib/harness");
      suite("what it is", async (t) => {
        const stage = await t.stage();
        t.check(condition, "what should be true", "what was actually seen");
      });

  `t.check` prints a line and remembers the result; the process exits non-zero
  if anything failed, so run-all.js and CI can tell.
*/

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** a port nobody else is on, so suites can run back to back */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startBridge(port) {
  // --no-tls because a self-signed certificate would make every page in every
  // suite an interstitial. The pages' own https-only paths (AudioWorklet) are
  // satisfied by 127.0.0.1, which browsers treat as a secure context.
  const proc = spawn("node", ["scan/scan-bridge.js", "--port", String(port), "--no-tls"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const up = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("connect", () => (socket.destroy(), resolve(true)));
      socket.on("error", () => resolve(false));
    });
    if (up) return proc;
  }
  throw new Error("the bridge never came up");
}

function makeContext({ page: base, browser, port }) {
  const results = [];
  const t = {
    sleep,
    ROOT,
    port,
    browser,
    base,

    check(ok, what, detail) {
      results.push(!!ok);
      console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? ` — ${detail}` : ""}`);
      return !!ok;
    },
    note(line) {
      console.log(`        ${line}`);
    },
    section(title) {
      console.log(`\n${title}\n`);
    },

    /** a player page. `audio` costs a second or two and a lot of memory, so
     *  it is opt-in: most things a player does are visible without it. */
    async player({ part = "I", seat = 1, query = "", audio = false, viewport } = {}) {
      const page = await browser.newPage(viewport ? { viewport } : undefined);
      page.on("pageerror", (e) => console.log(`    player error: ${e.message}`));
      const q = `?part=${part}&seat=${seat}${query}`;
      await page.goto(`${base}/scan/${q}`, { waitUntil: "load" });
      await page.waitForFunction(() => window.scan && window.scan.part, null, { timeout: 30000 });
      if (audio) {
        await page.evaluate(() => window.scan.enableAudio());
        await page.waitForFunction(() => window.scan.isReady(), null, { timeout: 30000 });
      }
      return page;
    },

    /** a fresh browser profile, so localStorage is empty — a different laptop */
    async freshPlayer(opts = {}) {
      const context = await browser.newContext(opts.viewport ? { viewport: opts.viewport } : undefined);
      const page = await context.newPage();
      page.on("pageerror", (e) => console.log(`    player error: ${e.message}`));
      await page.goto(`${base}/scan/${opts.query || ""}`, { waitUntil: "load" });
      await page.waitForFunction(() => window.scan && window.scan.part, null, { timeout: 30000 });
      return { page, context };
    },

    async stage({ query = "", viewport = { width: 1600, height: 900 } } = {}) {
      const page = await browser.newPage({ viewport });
      page.on("pageerror", (e) => console.log(`    stage error: ${e.message}`));
      await page.goto(`${base}/scan/stage.html${query}`, { waitUntil: "load" });
      await page.waitForFunction(() => window.stage && window.stage.take, null, { timeout: 20000 });
      return page;
    },

    async desk({ viewport = { width: 1400, height: 900 } } = {}) {
      const page = await browser.newPage({ viewport });
      page.on("pageerror", (e) => console.log(`    desk error: ${e.message}`));
      await page.goto(`${base}/scan/conduct.html`, { waitUntil: "load" });
      await page.waitForFunction(() => window.conduct && window.conduct.cues.length, null, { timeout: 20000 });
      return page;
    },

    get passed() {
      return results.filter(Boolean).length;
    },
    get failed() {
      return results.filter((r) => !r).length;
    },
  };
  return t;
}

/** run one suite, print a tally, and exit non-zero if anything failed */
function suite(name, body) {
  (async () => {
    const port = await freePort();
    const bridge = await startBridge(port);
    const browser = await chromium.launch({
      args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-gpu"],
    });
    const t = makeContext({ page: `http://127.0.0.1:${port}`, browser, port });
    console.log(`\n=== ${name} ===`);
    let threw = null;
    try {
      await body(t);
    } catch (e) {
      threw = e;
    }
    await browser.close().catch(() => {});
    bridge.kill();
    if (threw) {
      console.log(`\n  the suite itself fell over: ${threw.message}`);
      console.log(threw.stack.split("\n").slice(1, 4).join("\n"));
      process.exit(2);
    }
    console.log(`\n${t.passed} passed, ${t.failed} failed`);
    process.exit(t.failed ? 1 : 0);
  })();
}

module.exports = { suite, sleep, ROOT, freePort, startBridge };
