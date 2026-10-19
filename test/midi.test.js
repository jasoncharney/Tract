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

/** a Standard MIDI File reader, from the spec */
function parseSMF(buf) {
  let p = 0;
  const tag = () => buf.toString("ascii", p, (p += 4));
  const u32 = () => ((buf[p++] << 24) | (buf[p++] << 16) | (buf[p++] << 8) | buf[p++]) >>> 0;
  const u16 = () => (buf[p++] << 8) | buf[p++];
  if (tag() !== "MThd") throw new Error("not a MIDI file");
  const headerLen = u32();
  const format = u16();
  const ntracks = u16();
  const division = u16();
  p += headerLen - 6;

  const tracks = [];
  let tempo = 500000;
  for (let i = 0; i < ntracks; i++) {
    if (tag() !== "MTrk") throw new Error(`track ${i} is not an MTrk`);
    const len = u32();
    const end = p + len;
    let tick = 0;
    let running = null;
    const events = [];
    const markers = [];
    let name = "";
    while (p < end) {
      let delta = 0;
      for (;;) {
        const b = buf[p++];
        delta = (delta << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      tick += delta;
      let status = buf[p];
      if (status & 0x80) p++;
      else status = running;
      if (status === undefined) throw new Error("running status with no status");
      if (status === 0xff) {
        const type = buf[p++];
        let n = 0;
        for (;;) {
          const b = buf[p++];
          n = (n << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        const data = buf.slice(p, p + n);
        p += n;
        if (type === 0x51) tempo = (data[0] << 16) | (data[1] << 8) | data[2];
        if (type === 0x03) name = data.toString("utf8");
        if (type === 0x06) markers.push({ tick, text: data.toString("utf8") });
        running = null;
        continue;
      }
      running = status;
      const kind = status & 0xf0;
      const channel = (status & 0x0f) + 1;
      if (kind === 0xc0 || kind === 0xd0) {
        p += 1;
        continue;
      }
      const d1 = buf[p++];
      const d2 = buf[p++];
      events.push({ tick, kind, channel, d1, d2 });
    }
    if (p !== end) throw new Error(`track ${i} overran its declared length by ${p - end}`);
    tracks.push({ name, events, markers });
  }
  if (p !== buf.length) throw new Error("trailing bytes after the last track");
  return { format, ntracks, division, tempo, tracks };
}

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
});
