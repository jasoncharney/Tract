#!/usr/bin/env node
/*
  midi/testers.js — eight player windows, one per MIDI track, ready to play.

      node midi/testers.js            open them (again: closes the old eight first)
      node midi/testers.js --port 8081

  Or double-click midi/open-testers.command in the Finder.

  WHY IT IS A SEPARATE CHROME. The windows run in their own Chrome profile, not
  your everyday one, so it can be told things you would not want your own
  browser told: accept the bridge's self-made certificate without the warning,
  let MIDI in without asking, and start audio without a click. Each of those
  was a click per window, eight times, every time — and a window whose audio
  was never clicked awake takes the notes and does nothing at all. The profile
  lives in ~/Library/Application Support/Tract testers and remembers nothing
  that matters; delete it whenever.

  If the bridge is not running, this starts it and stays in the foreground
  with its log, so closing the terminal (or ctrl-C) stops it. If it is already
  running, this opens the windows and gets out of the way.

  The windows come from the same list make-midi.js writes its tracks for —
  read out of that file, not copied, so the two cannot disagree about who is on
  which channel.
*/

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(arg("port", 8080));
const HEADLESS = argv.includes("--headless"); // for checking this script, not for playing
const PROFILE = arg("profile", path.join(os.homedir(), "Library", "Application Support", "Tract testers"));
const CHROME =
  process.env.CHROME ||
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find(
    (p) => fs.existsSync(p)
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** who plays on which channel, as make-midi.js has it */
function players() {
  const src = fs.readFileSync(path.join(__dirname, "make-midi.js"), "utf8");
  const block = src.match(/const PLAYERS = \[([\s\S]*?)\];/);
  const found = block
    ? [...block[1].matchAll(/part:\s*"(\d)",\s*seat:\s*(\d),\s*channel:\s*(\d+)/g)].map((m) => ({
        part: ["", "I", "II", "III", "IV"][Number(m[1])],
        seat: Number(m[2]),
        channel: Number(m[3]),
      }))
    : [];
  if (found.length === 0) throw new Error("could not read PLAYERS out of make-midi.js");
  return found;
}

const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });

/** the bridge decides https or http for itself; ask it rather than assume */
async function scheme() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
    return "http";
  } catch (e) {
    return "https";
  }
}

/** a CDP connection to the testers' Chrome, browser-wide */
async function devtools() {
  const portFile = path.join(PROFILE, "DevToolsActivePort");
  let launched = null;
  const attach = async () => {
    const [port] = fs.readFileSync(portFile, "utf8").split("\n");
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    return webSocketDebuggerUrl;
  };
  let url = null;
  try {
    url = await attach(); // already open from last time
  } catch (e) {
    try {
      fs.unlinkSync(portFile); // stale, from a Chrome that has since quit
    } catch (e2) {}
    fs.mkdirSync(PROFILE, { recursive: true });
    launched = spawn(
      CHROME,
      [
        `--user-data-dir=${PROFILE}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        ...(HEADLESS ? ["--headless=new"] : []),
        "about:blank",
      ],
      { stdio: "ignore", detached: !HEADLESS }
    );
    if (!HEADLESS) launched.unref(); // the windows outlive this script
    for (let i = 0; i < 75 && !url; i++) {
      await sleep(200);
      try {
        url = await attach();
      } catch (e2) {}
    }
    if (!url) throw new Error("Chrome started but never opened its DevTools port");
  }

  const ws = new WebSocket(url);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error("could not reach Chrome")))));
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (!waiting.has(d.id)) return;
    const { resolve, reject } = waiting.get(d.id);
    waiting.delete(d.id);
    d.error ? reject(new Error(`${d.error.message}`)) : resolve(d.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      waiting.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { send, close: () => ws.close(), launched };
}

async function openWindows() {
  const base = `${await scheme()}://localhost:${PORT}`;
  const cdp = await devtools();
  const { send } = cdp;

  // The bridge's certificate is its own, so every window would stop at a
  // warning. Told here, for this Chrome only, never your own.
  await send("Security.setIgnoreCertificateErrors", { ignore: true });
  // MIDI and audio without eight prompts
  for (const permission of ["midi", "midiSysex"]) {
    await send("Browser.setPermission", { permission: { name: permission }, setting: "granted", origin: base }).catch(() => {});
  }

  const old = (await send("Target.getTargets")).targetInfos.filter((t) => t.type === "page");

  const who = players();
  const opened = [];
  for (const p of who) {
    const url = `${base}/scan/?part=${p.part}&seat=${p.seat}&midich=${p.channel}`;
    const { targetId } = await send("Target.createTarget", { url, newWindow: true });
    opened.push({ ...p, targetId, url });
  }
  // the old eight go once the new ones exist, so Chrome never has no windows
  for (const t of old) await send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});

  // where the screen is, asked of a page, since only a page knows
  const first = await send("Target.attachToTarget", { targetId: opened[0].targetId, flatten: true });
  const evaluate = async (sessionId, expression) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  const screen = await evaluate(
    first.sessionId,
    "({ x: screen.availLeft || 0, y: screen.availTop || 0, w: screen.availWidth, h: screen.availHeight })"
  );

  // four across, two down, in channel order: the top row is parts I and II
  const cols = 4;
  const rows = Math.ceil(opened.length / cols);
  const w = Math.floor(screen.w / cols);
  const h = Math.floor(screen.h / rows);
  for (const [i, p] of opened.entries()) {
    const { windowId } = await send("Browser.getWindowForTarget", { targetId: p.targetId });
    await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: screen.x + (i % cols) * w, top: screen.y + Math.floor(i / cols) * h, width: w, height: h },
    });
  }

  // Wake each one's audio, so the first note is heard rather than swallowed.
  // All at once: a window that is not in front boots on throttled timers, and
  // one at a time that was twenty seconds a window.
  const report = await Promise.all(
    opened.map(async (p) => {
      const { sessionId } =
        p === opened[0] ? first : await send("Target.attachToTarget", { targetId: p.targetId, flatten: true });
      let state = "did not load";
      for (let i = 0; i < 150; i++) {
        if (await evaluate(sessionId, "!!(window.scan && window.scan.part)").catch(() => false)) {
          state = await evaluate(
            sessionId,
            `window.scan.enableAudio().then(() => new Promise((r) => {
               const t0 = performance.now();
               (function wait() {
                 if (window.scan.isReady() || performance.now() - t0 > 15000) r(window.scan.isReady() ? "ready" : "audio did not start");
                 else setTimeout(wait, 100);
               })();
             }))`
          ).catch((e) => e.message);
          break;
        }
        await sleep(200);
      }
      const pill = await evaluate(sessionId, "document.getElementById('midiPill')?.textContent || ''").catch(() => "");
      await send("Target.detachFromTarget", { sessionId }).catch(() => {});
      return { ...p, state, pill };
    })
  );
  cdp.close();
  return { base, report, launched: cdp.launched };
}

(async () => {
  if (!CHROME) {
    console.error("no Google Chrome in /Applications — set CHROME=/path/to/chrome");
    process.exit(1);
  }
  let bridge = null;
  if (!(await listening(PORT))) {
    console.log(`starting the bridge on ${PORT}`);
    bridge = spawn("node", ["scan/scan-bridge.js", "--port", String(PORT)], { cwd: ROOT, stdio: "inherit" });
    for (let i = 0; i < 60 && !(await listening(PORT)); i++) await sleep(100);
    if (!(await listening(PORT))) {
      console.error("the bridge did not come up");
      process.exit(1);
    }
  }

  let result;
  try {
    result = await openWindows();
  } catch (e) {
    console.error(`could not open the windows: ${e.message}`);
    if (bridge) bridge.kill();
    process.exit(1);
  }
  console.log(`\n${result.report.length} windows on ${result.base}`);
  result.report.forEach((r) =>
    console.log(`  ch ${String(r.channel).padStart(2)}  ${r.part.padEnd(3)} seat ${r.seat}   ${r.state.padEnd(10)} ${r.pill}`)
  );
  const notConnected = result.report.some((r) => /not connected/.test(r.pill));
  if (notConnected) {
    console.log(
      "\nno MIDI input yet — switch on the IAC bus (Audio MIDI Setup → MIDI Studio →\n" +
        "IAC Driver → Device is online). The windows will hear it the moment it appears."
    );
  }
  console.log("\nIn the DAW: import midi/out/tract-all.mid, send every track to the IAC bus, play.");

  if (HEADLESS && result.launched) result.launched.kill();
  if (bridge) {
    console.log("\nthe bridge is running here — close this window or press ctrl-C to stop it\n");
    process.on("SIGINT", () => (bridge.kill(), process.exit(0)));
    bridge.on("exit", () => process.exit(0));
  }
})();
