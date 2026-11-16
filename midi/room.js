#!/usr/bin/env node
/*
  midi/room.js — a whole rehearsal on one machine: nine players, the desk,
  and the wall.

      node midi/room.js               open them (again: closes the old ones first)
      node midi/room.js --port 8081

  Or double-click Testers.command in the Finder.

  The nine players and the conductor's desk are tiled five by two on the main
  display, desk last. The wall goes fullscreen on the second display, the way
  the projector will have it; with only one display it gets a plain window on
  top of the tiles instead.

  The desk drives the cues, and the players can be played by hand or by MIDI:
  each one listens on the channel make-midi.js writes for its part, the same
  channels midi/testers.js uses, so tract-all.mid into the IAC bus plays all
  nine at once. Nine players on eight tracks: the third on I doubles channel 1.
  The wall is not on MIDI here — the desk advances it. Seats are not forced
  either — the nine sort themselves out of the roster the way nine laptops
  would, so a doubled channel may land on a different seat than its track's.

  Same Chrome and profile as midi/testers.js (see the top of that file for
  why), so running either one replaces the other's windows.
*/

const { PORT, HEADLESS, CHROME, sleep, scheme, devtools, evaluateIn, wake, ensureBridge, players } = require("./testers.js");

// three on I, two on each of the others: one part with an odd count, so
// "assign" phrases get a seat that wraps round the written pitches
const PLAYERS = ["I", "I", "I", "II", "II", "III", "III", "IV", "IV"];

/** each player's channel: the nth on a part takes that part's nth track, wrapping */
function channels() {
  const tracks = players();
  const count = {};
  return PLAYERS.map((part) => {
    const mine = tracks.filter((t) => t.part === part);
    const n = (count[part] = (count[part] || 0) + 1);
    return { part, channel: mine[(n - 1) % mine.length].channel };
  });
}

async function openWindows() {
  const base = `${await scheme()}://localhost:${PORT}`;
  const cdp = await devtools();
  const { send } = cdp;
  const evaluate = evaluateIn(send);

  await send("Security.setIgnoreCertificateErrors", { ignore: true });
  // getScreenDetails() is the only way a page learns about a second display.
  // Chrome has called the permission both of these.
  for (const name of ["window-management", "window-placement"]) {
    await send("Browser.setPermission", { permission: { name }, setting: "granted", origin: base }).catch(() => {});
  }
  // MIDI without nine prompts
  for (const name of ["midi", "midiSysex"]) {
    await send("Browser.setPermission", { permission: { name }, setting: "granted", origin: base }).catch(() => {});
  }

  const old = (await send("Target.getTargets")).targetInfos.filter((t) => t.type === "page");
  const open = async (url) => (await send("Target.createTarget", { url, newWindow: true })).targetId;

  const players = [];
  for (const p of channels()) players.push({ ...p, targetId: await open(`${base}/scan/?part=${p.part}&midich=${p.channel}`) });
  const desk = await open(`${base}/scan/conduct.html`);
  const wall = await open(`${base}/scan/stage.html`);
  for (const t of old) await send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});

  // the displays, asked of the desk, which has no reason to be busy yet — but
  // only once it has loaded: straight after createTarget the window is still
  // on its first about:blank, which is not the origin granted the permission,
  // so getScreenDetails() throws and the second display is never found
  const { sessionId } = await send("Target.attachToTarget", { targetId: desk, flatten: true });
  for (let i = 0; i < 100; i++) {
    if ((await evaluate(sessionId, "location.origin").catch(() => "")) === new URL(base).origin) break;
    await sleep(100);
  }
  const screens = await evaluate(
    sessionId,
    `(async () => {
       const pick = (s) => ({ x: s.availLeft, y: s.availTop, w: s.availWidth, h: s.availHeight, primary: !!s.isPrimary });
       try {
         return (await window.getScreenDetails()).screens.map(pick);
       } catch (e) {
         return [{ ...pick(screen), primary: true }];
       }
     })()`
  );
  await send("Target.detachFromTarget", { sessionId }).catch(() => {});
  const main = screens.find((s) => s.primary) || screens[0];
  const second = screens.find((s) => s !== main) || null;

  // Bounds must be whole pixels: CDP refuses 322.5 with a bare "Invalid
  // parameters", and that refusal used to end the run before a single player
  // was woken. A window that will not move is a cosmetic problem, so it is
  // reported and the rest carry on.
  const place = async (targetId, bounds, state = "normal") => {
    for (const k of Object.keys(bounds)) bounds[k] = Math.round(bounds[k]);
    try {
      const { windowId } = await send("Browser.getWindowForTarget", { targetId });
      await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await send("Browser.setWindowBounds", { windowId, bounds });
      if (state !== "normal") await send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } });
    } catch (e) {
      console.log(`could not place a window (${JSON.stringify(bounds)}): ${e.message}`);
    }
  };

  const tiles = [...players.map((p) => p.targetId), desk];
  const cols = 5;
  const rows = Math.ceil(tiles.length / cols);
  const w = Math.floor(main.w / cols);
  const h = Math.floor(main.h / rows);
  for (const [i, targetId] of tiles.entries()) {
    await place(targetId, { left: main.x + (i % cols) * w, top: main.y + Math.floor(i / cols) * h, width: w, height: h });
  }
  // fullscreen fills whichever display the window is on, so move it there first
  if (second) await place(wall, { left: second.x + 40, top: second.y + 40, width: 800, height: 450 }, "fullscreen");
  else await place(wall, { left: main.x + w, top: main.y + h / 2, width: w * 3, height: h });

  const report = await Promise.all(players.map(async (p) => ({ ...p, ...(await wake(send, p.targetId)) })));
  cdp.close();
  return { base, report, second, launched: cdp.launched };
}

(async () => {
  if (!CHROME) {
    console.error("no Google Chrome in /Applications — set CHROME=/path/to/chrome");
    process.exit(1);
  }
  const bridge = await ensureBridge();

  let result;
  try {
    result = await openWindows();
  } catch (e) {
    console.error(`could not open the windows: ${e.message}`);
    if (bridge) bridge.kill();
    process.exit(1);
  }
  console.log(`\n${result.report.length} players on ${result.base}`);
  result.report.forEach((r) =>
    console.log(`  ch ${String(r.channel).padStart(2)}  ${r.part.padEnd(3)}  ${r.state.padEnd(10)} ${r.pill}`)
  );
  console.log(`  the desk    ${result.base}/scan/conduct.html`);
  console.log(
    result.second
      ? `  the wall    fullscreen on the second display`
      : `  the wall    in a window — there is no second display to put it on`
  );
  if (result.report.some((r) => /not connected/.test(r.pill))) {
    console.log(
      "\nno MIDI input yet — switch on the IAC bus (Audio MIDI Setup → MIDI Studio →\n" +
        "IAC Driver → Device is online). The windows will hear it the moment it appears."
    );
  }

  if (HEADLESS && result.launched) result.launched.kill();
  if (bridge) {
    console.log("\nthe bridge is running here — close this window or press ctrl-C to stop it\n");
    process.on("SIGINT", () => (bridge.kill(), process.exit(0)));
    bridge.on("exit", () => process.exit(0));
  }
})();
