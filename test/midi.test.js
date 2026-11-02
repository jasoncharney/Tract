/*
  The MIDI rig: the files make-midi.js writes, and what the player's page does
  when they are played into it.

  The file is parsed back by a reader written from the Standard MIDI File spec
  rather than from the writer, so a shared misunderstanding cannot pass. That
  is not theoretical — it caught a real one: the cue markers contain "·",
  which is one JavaScript character and two UTF-8 bytes, so every meta-event
  length was written one short and the file was malformed.
*/

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { suite, ROOT } = require("./lib/harness");

const OUT = path.join(ROOT, "midi", "out");

const { parseSMF } = require("./lib/smf");

suite("midi", async (t) => {
  t.section("1 — the generator runs and writes a Standard MIDI File");
  const said = execFileSync("node", ["midi/make-midi.js"], { cwd: ROOT, encoding: "utf8" });
  t.check(/cues · .* players/.test(said), "make-midi.js runs", said.split("\n").find((l) => /cues/.test(l)) || "");
  const rates = said.match(/scan rates from scan\.js: (.*)/);
  t.check(!!rates, "and reads the scan rates out of scan.js rather than keeping a copy", rates ? rates[1] : "did not");

  const all = parseSMF(fs.readFileSync(path.join(OUT, "tract-all.mid")));
  t.check(all.format === 1, "format 1, so a DAW sees separate tracks", `format ${all.format}`);
  t.check(all.ntracks === 9, "nine tracks: eight players and a conductor", `${all.ntracks}`);
  t.check(all.tempo === 1000000, "60 bpm, so a beat is a second and the grid reads in seconds", `${(60000000 / all.tempo).toFixed(0)} bpm`);

  const timing = JSON.parse(fs.readFileSync(path.join(ROOT, "midi", "timing.json"), "utf8"));
  const conductor = all.tracks[0];
  t.check(conductor.markers.length === timing.cues.length, "a marker for every cue", `${conductor.markers.length}`);
  let want = 0;
  const drift = conductor.markers.map((m, i) => {
    const err = Math.abs(m.tick / all.division - want);
    want += Math.max(0.2, Number(timing.cues[i].seconds) || 0);
    return err;
  });
  t.check(Math.max(...drift) < 0.01, "each one where timing.json puts that cue", `worst ${Math.max(...drift).toFixed(4)} s`);

  const players = all.tracks.slice(1);
  t.check(
    players.every((tr, i) => tr.events.every((e) => e.channel === i + 1)),
    "each player stays on its own channel"
  );
  let dangling = 0;
  players.forEach((tr) => {
    const open = new Map();
    tr.events.forEach((e) => {
      const on = e.kind === 0x90 && e.d2 > 0;
      const off = e.kind === 0x80 || (e.kind === 0x90 && e.d2 === 0);
      if (on) open.set(e.d1, (open.get(e.d1) || 0) + 1);
      else if (off) {
        const n = open.get(e.d1) || 0;
        if (n === 0) dangling++;
        else open.set(e.d1, n - 1);
      }
    });
    dangling += [...open.values()].reduce((a, b) => a + b, 0);
  });
  t.check(dangling === 0, "every note on has a note off", `${dangling} dangling`);
  const notes = new Set();
  players.forEach((tr) => tr.events.forEach((e) => (e.kind === 0x90 || e.kind === 0x80) && notes.add(e.d1)));
  t.check([...notes].every((n) => n < 24), "nothing strays into the pitch keyboard", `used ${[...notes].sort((a, b) => a - b).join(",")}`);

  t.section("2 — the phrase lane");
  const lane = parseSMF(fs.readFileSync(path.join(OUT, "tract-I-1.mid"))).tracks[1];
  const held = [];
  const open = new Map();
  lane.events
    .filter((e) => e.d1 >= 15 && e.d1 <= 23 && (e.kind === 0x90 || e.kind === 0x80))
    .forEach((e) => {
      if (e.kind === 0x90 && e.d2 > 0) open.set(e.d1, e.tick);
      else if (open.has(e.d1)) {
        held.push({ note: e.d1, from: open.get(e.d1) / 480, to: e.tick / 480 });
        open.delete(e.d1);
      }
    });
  held.sort((a, b) => a.from - b.from);
  const cc20 = lane.events.filter((e) => e.kind === 0xb0 && e.d1 === 20);
  t.note(held.map((h) => `ph${h.note - 15} ${h.from.toFixed(0)}–${h.to.toFixed(0)}s`).join("  "));
  t.check(held.length >= 8, "one long note per phrase, not a blip per change", `${held.length} spans`);
  t.check(held.every((h) => h.to - h.from > 5), "each long enough to see and drag", `shortest ${Math.min(...held.map((h) => h.to - h.from)).toFixed(0)}s`);
  t.check(held.every((h, i) => i === 0 || h.from >= held[i - 1].to - 0.11), "and they do not overlap");
  t.check(cc20.length === held.length, "a CC20 beside each, for hosts that chase controllers not notes", `${cc20.length}`);

  t.section("2b — a part keeps going until it is told otherwise");
  const starts = [];
  let clock = 0;
  timing.cues.forEach((c) => (starts.push(clock), (clock += c.seconds)));
  const cueAt = (id) => starts[timing.cues.findIndex((c) => c.id === String(id))];
  const mid = (id) => cueAt(id) + timing.cues.find((c) => c.id === String(id)).seconds / 2;
  const sec = (e) => e.tick / all.division;
  // One NaN in the timeline broke the sort, and the file still parsed — it
  // just ran 764 s instead of 337, with half the events in the wrong place.
  const last = Math.max(...players.map((tr) => sec(tr.events[tr.events.length - 1])));
  t.check(last <= clock + 0.01, "nothing lands after the end of the piece", `last event ${last.toFixed(1)} s of ${clock.toFixed(1)}`);
  const I1 = players[0].events;
  const pressesA = I1.filter((e) => e.d1 === 0 && e.kind === 0x90 && e.d2 > 0).map(sec);
  const heldThrough = (events, note, t) => {
    let down = null;
    for (const e of events) {
      if (e.d1 !== note || e.kind === 0xb0) continue;
      if (e.kind === 0x90 && e.d2 > 0) down = sec(e);
      else if (down !== null) {
        if (down <= t && sec(e) > t) return true;
        down = null;
      }
    }
    return false;
  };
  t.check(
    pressesA.some((x) => x >= cueAt(3)) && heldThrough(I1, 0, mid(4)),
    "Part I's A, given in cue 2, is still scanning through II's and III's entries",
    `A pressed at ${pressesA.map((x) => x.toFixed(0)).join(", ")} s`
  );
  // whisper is a held note now, so its state can be read straight off the file
  const whispers = [
    [0, 9, true, "I in cue 9, after 'Press {Z} for whisper on' in cue 7"],
    [0, 19, false, "I in cue 19, 'whisper off'"],
    [2, 27, true, "II in cue 27, whispering since cue 25"],
    [2, 30, false, "II in cue 30, after 'whisper off' in cue 29"],
    [6, 9, false, "IV in cue 9, which was never told to whisper"],
  ];
  for (const [p, id, want, what] of whispers) {
    const got = heldThrough(players[p].events, 14, mid(id));
    t.check(got === want, `whisper is ${want ? "on" : "off"} for ${what}`, `${got ? "on" : "off"}`);
  }

  t.section("3 — what the page does when those notes arrive");
  const page = await t.player({ query: "&midich=3", audio: true });
  t.check((await page.evaluate(() => window.scan.midiChannel)) === 3, "?midich=3 is picked up");
  t.check(await page.evaluate(() => !document.getElementById("midiPill").hidden), "and the window says which channel it is");

  const say = (bytes, wait = 260) =>
    page.evaluate(
      async ([b, w]) => {
        window.scan.handleMIDI(b);
        await new Promise((r) => setTimeout(r, w));
        return {
          phrase: window.scan.phrase,
          mode: window.scan.transport.mode,
          pos: Math.round(window.scan.position * 100) / 100,
          gate: /gate <b>on/.test(document.getElementById("readout").innerHTML),
          whisper: document.getElementById("whisperTag").dataset.on === "1",
          note: Math.round(window.scan.note * 100) / 100,
        };
      },
      [bytes, wait]
    );

  const CH = 0x92;
  const OFF = 0x82;
  await page.evaluate(() => window.scan.applyRemote("/scan/phrase", [1]));
  await t.sleep(200);
  t.check((await say([0x90, 20, 100])).phrase === 1, "a note on another channel is ignored");

  t.check((await say([CH, 18, 100])).phrase === 3, "note 18 goes to phrase 3");
  let r = await say([CH, 0, 100]);
  t.check(r.mode === "scan" && r.gate, "note 0 holds A", `mode ${r.mode}`);
  r = await say([OFF, 0, 0]);
  t.check(r.mode === null && !r.gate, "and letting it go releases the key");
  r = await say([CH, 5, 100], 150);
  t.check(r.mode === "word", "note 5 plays one word");
  await say([CH, 11, 100]);
  t.check((await say([OFF, 11, 0], 150)).mode === null, "note 11 stops it mid-word");
  t.check((await say([CH, 8, 100], 200)).whisper === true, "note 8 turns whisper on");
  await say([OFF, 8, 0], 40);
  t.check((await say([CH, 8, 100], 200)).whisper === false, "and the next one turns it off");
  await say([OFF, 8, 0], 40);

  const swept = await page.evaluate(async () => {
    window.scan.handleMIDI([0x92, 13, 100]);
    const seen = [];
    for (let i = 0; i <= 10; i++) {
      window.scan.handleMIDI([0xb2, 1, Math.round((i / 10) * 127)]);
      await new Promise((r2) => setTimeout(r2, 40));
      seen.push(window.scan.position);
    }
    const during = /gate <b>on/.test(document.getElementById("readout").innerHTML);
    window.scan.handleMIDI([0x82, 13, 0]);
    await new Promise((r2) => setTimeout(r2, 250));
    return { seen, during, after: /gate <b>on/.test(document.getElementById("readout").innerHTML), cells: window.scan.cells.length };
  });
  t.check(swept.during, "note 13 is the mouse button, and holding it opens the gate");
  t.check(
    swept.seen[swept.seen.length - 1] > swept.cells * 0.9,
    "CC1 drags the playhead across the strip",
    `${swept.seen[0].toFixed(1)} → ${swept.seen[swept.seen.length - 1].toFixed(1)} of ${swept.cells}`
  );
  t.check(!swept.after, "and letting it go closes the gate — no sweep left hanging open");

  r = await say([CH, 40, 100], 200);
  t.check(Math.round(r.note) === 40 && r.gate, "notes from C1 up still set the pitch, as before");
  await say([OFF, 40, 0], 100);

  t.section("3b — pressing stop in the DAW");
  // a host that stops with All Notes Off rather than a note off per note
  for (const [bytes, what] of [
    [[0xb2, 123, 0], "All Notes Off (CC123)"],
    [[0xb2, 120, 0], "All Sound Off (CC120)"],
    [[0xfc], "MIDI Stop (0xFC), which has no channel"],
  ]) {
    await say([CH, 9, 100], 100); // the pedal down
    const held = await say([CH, 0, 100], 400); // and A held under it
    const after = await say(bytes, 250);
    const pedal = await page.evaluate(() => window.scan.pedalDown);
    t.check(
      held.mode === "scan" && after.mode === null && !after.gate && !pedal,
      `${what} lets go of a held scan and the pedal`,
      `mode ${held.mode} → ${after.mode}, gate ${after.gate}, pedal ${pedal}`
    );
    await say([OFF, 0, 0], 40);
    await say([OFF, 9, 0], 40);
  }

  t.section("3c — clicking into the DAW mid-take");
  const blurred = await page.evaluate(async () => {
    window.scan.handleMIDI([0x92, 0, 100]);
    await new Promise((r2) => setTimeout(r2, 300));
    window.dispatchEvent(new Event("blur"));
    await new Promise((r2) => setTimeout(r2, 300));
    const mode = window.scan.transport.mode;
    window.scan.handleMIDI([0x82, 0, 0]);
    return mode;
  });
  t.check(blurred === "scan", "a sequenced window losing focus does not drop the note it is holding", `mode ${blurred}`);

  t.section("3d — what the generated files lean on");
  const w = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r2) => setTimeout(r2, ms));
    const seen = [];
    if (window.scan.whisper) window.scan.toggleWhisper();
    window.scan.handleMIDI([0x92, 14, 100]);
    await wait(100);
    seen.push(window.scan.whisper);
    window.scan.handleMIDI([0x92, 14, 100]); // a host chasing the note sends it again
    await wait(100);
    seen.push(window.scan.whisper);
    window.scan.handleMIDI([0x82, 14, 0]);
    await wait(100);
    seen.push(window.scan.whisper);
    return seen;
  });
  t.check(w[0] && w[1] && !w[2], "note 14 is whisper as a state: on while held, still on when sent twice, off after", w.join(" → "));

  r = await say([0xb2, 21, 62], 200);
  t.check(Math.round(r.note) === 62 && !r.gate, "CC21 sets the pitch and leaves the gate shut", `note ${r.note}, gate ${r.gate}`);

  await say([CH, 9, 100], 100);
  await say([CH, 13, 100], 200);
  const underPedal = await say([OFF, 13, 0], 300);
  const afterPedal = await say([OFF, 9, 0], 400);
  t.check(underPedal.gate && !afterPedal.gate, "the mouse coming up under the pedal keeps the sound, until the pedal lifts", `${underPedal.gate} → ${afterPedal.gate}`);

  await say([CH, 3, 100], 150); // W: a long word, playing
  await say([OFF, 3, 0], 40);
  const grabbed = await say([CH, 13, 100], 150);
  await say([OFF, 13, 0], 200);
  t.check(grabbed.mode === null, "taking the mouse cancels a word still playing, as a real mouse does", `mode ${grabbed.mode}`);

  const sustained = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r2) => setTimeout(r2, ms));
    window.scan.applyRemote("/scan/phrase", [2]); // CRACK: two cells, over in a moment on D
    await wait(300);
    window.scan.handleMIDI([0x92, 9, 100]);
    window.scan.handleMIDI([0x92, 2, 100]);
    await wait(1500);
    const at = { mode: window.scan.transport.mode, gate: /gate <b>on/.test(document.getElementById("readout").innerHTML) };
    window.scan.handleMIDI([0x82, 2, 0]);
    window.scan.handleMIDI([0x82, 9, 0]);
    await wait(300);
    return at;
  });
  t.check(sustained.mode === null && sustained.gate, "a scan that reaches the end under the pedal keeps sounding", `mode ${sustained.mode}, gate ${sustained.gate}`);

  t.section("4 — skipping around in the DAW");
  const landed = await page.evaluate(async () => {
    window.scan.applyRemote("/scan/phrase", [1]);
    await new Promise((r2) => setTimeout(r2, 250));
    window.scan.handleMIDI([0xb2, 20, 5]); // what a host chases on locate
    await new Promise((r2) => setTimeout(r2, 400));
    return window.scan.phrase;
  });
  t.check(landed === 5, "locating into the middle of a phrase lands the window on it", `phrase ${landed}`);

  const idem = await page.evaluate(async () => {
    window.scan.applyRemote("/scan/phrase", [3]);
    await new Promise((r2) => setTimeout(r2, 250));
    window.scan.handleMIDI([0x92, 0, 100]); // a scan is running
    await new Promise((r2) => setTimeout(r2, 600));
    const before = { mode: window.scan.transport.mode, pos: window.scan.position };
    window.scan.handleMIDI([0xb2, 20, 3]); // the same phrase again
    window.scan.handleMIDI([0x92, 18, 100]);
    await new Promise((r2) => setTimeout(r2, 300));
    const after = { mode: window.scan.transport.mode, pos: window.scan.position };
    window.scan.handleMIDI([0x82, 0, 0]);
    return { before, after };
  });
  t.check(
    idem.before.mode === "scan" && idem.after.mode === "scan" && idem.after.pos > idem.before.pos,
    "a repeat of the phrase you are already on does not stop a running scan",
    `${idem.before.pos.toFixed(2)} → ${idem.after.pos.toFixed(2)}`
  );

  t.section("5 — and a performer's window knows none of it");
  const plain = await t.browser.newPage();
  const asked = [];
  await plain.exposeFunction("__midiAsked", () => asked.push(1));
  await plain.addInitScript(() => {
    const real = navigator.requestMIDIAccess;
    navigator.requestMIDIAccess = function (...a) {
      window.__midiAsked();
      return real ? real.apply(this, a) : Promise.reject(new Error("none"));
    };
  });
  await plain.goto(`${t.base}/scan/`, { waitUntil: "load" });
  await plain.waitForFunction(() => window.scan && window.scan.part, null, { timeout: 30000 });
  await plain.waitForSelector("#partModal:not([hidden])", { timeout: 10000 });
  const hidden = await plain.evaluate(() => ({
    pill: document.getElementById("midiPill").hidden,
    picker: document.getElementById("modalMidi").hidden,
    options: document.getElementById("midiSel").options.length,
    channel: window.scan.midiChannel,
  }));
  await t.sleep(500);
  t.check(hidden.pill && hidden.picker && hidden.options === 0, "no pill, no picker, not even built");
  t.check(hidden.channel === null, "and no channel");
  t.check(asked.length === 0, "the browser is never asked for MIDI access — so no prompt", `asked ${asked.length}x`);
  await plain.close();

  t.section("6 — a window that is not in front");
  // Eight windows on one laptop means seven behind something, and Chrome all
  // but stops animation frames for those. Every other check in this file
  // misses that, because Playwright launches Chrome with background
  // throttling switched off and keeps the pages it drives "visible" — this
  // bug was invisible under both. So: the real binary, our own flags, a
  // second tab in front, and raw CDP that changes nothing about the page.
  const hidden2 = await behindAnotherTab(t, async (ev) => {
    return ev(`(async () => {
      let frames = 0;
      const c = () => { frames++; requestAnimationFrame(c); };
      requestAnimationFrame(c);
      window.scan.handleMIDI([0x92, 0, 100]);
      await new Promise((r) => setTimeout(r, 2000));
      const held = window.scan.position;
      window.scan.handleMIDI([0x82, 0, 0]);
      window.scan.handleMIDI([0x92, 5, 100]);
      window.scan.handleMIDI([0x82, 5, 0]);
      await new Promise((r) => setTimeout(r, 2500));
      return { vis: document.visibilityState, frames, held, word: window.scan.transport.mode };
    })()`);
  });
  t.check(hidden2.vis === "hidden" && hidden2.frames < 10, "the window really is behind: hidden, frames stopped", `${hidden2.vis}, ${hidden2.frames} frames in 4.5 s`);
  t.check(hidden2.held > 0.3, "a held A still moves along the strip", `0 → ${hidden2.held.toFixed(2)} in 2 s`);
  t.check(hidden2.word === null, "and a one-shot word still finishes instead of sounding forever", `mode ${hidden2.word}`);
});

/** a player on channel 3, phrase 3, audio on, with another tab in front of it */
async function behindAnotherTab(t, body) {
  const { chromium } = require("playwright");
  const { spawn } = require("child_process");
  const os = require("os");
  const { freePort } = require("./lib/harness");
  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tract-hidden-"));
  const chrome = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${dbg}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      `${t.base}/scan/?part=III&seat=1&midich=3`,
    ],
    { stdio: "ignore" }
  );
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await t.sleep(200);
      try {
        const list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
        target = list.find((x) => x.url.includes("/scan/"));
      } catch (e) {}
    }
    if (!target) throw new Error("the unmanaged Chromium never came up");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (waiting.has(d.id)) waiting.get(d.id)(d), waiting.delete(d.id);
    };
    const ev = (expression) =>
      new Promise((r) => {
        waiting.set(++id, (d) => r(d.result.result.value));
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      });
    for (let i = 0; i < 150 && !(await ev("!!(window.scan && window.scan.part)")); i++) await t.sleep(200);
    await ev("window.scan.enableAudio().then(() => 1)");
    for (let i = 0; i < 150 && !(await ev("window.scan.isReady()")); i++) await t.sleep(200);
    await ev("(window.scan.applyRemote('/scan/phrase', [3]), 1)");
    await t.sleep(300);
    await fetch(`http://127.0.0.1:${dbg}/json/new?about:blank`, { method: "PUT" });
    await t.sleep(1500);
    const out = await body(ev);
    ws.close();
    return out;
  } finally {
    // Chrome is still writing its profile as it exits; removing it under that
    // fails with ENOTEMPTY, so wait for the process before tidying up
    const gone = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await Promise.race([gone, t.sleep(5000)]);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {}
  }
}
