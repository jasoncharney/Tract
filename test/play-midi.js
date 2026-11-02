/*
  test/play-midi.js — play midi/out/tract-all.mid into real player pages, in
  real time, and say what they did.

      node test/play-midi.js           ~6 minutes: the whole piece, eight windows

  Not a .test.js, so run-all.js leaves it out: it takes as long as the piece.
  Run it after changing timing.json or make-midi.js. Reading the file back
  says what the notes are; only this says what a page does with them, and the
  first version of the new generator looked right as notes and was wrong on
  the page twice — a sweep's last positions landing after a phrase change and
  dragging the next scan half way along, and a re-press that only finished the
  old pass and then sat silent for eighteen seconds.

  Eight windows, each fed its own track. Every quarter second it
  samples the gate, whisper, phrase, transport and pitch. It prints a row per
  cue, and fails if a window ends a cue on the wrong phrase, or if every
  window is silent for longer than the score's own silences.
*/

const fs = require("fs");
const path = require("path");
const { suite, ROOT } = require("./lib/harness");
const { parseSMF } = require("./lib/smf");

const LONGEST_REST = 2.6; // "Stop. Silence." in cue 12 is the longest the score asks for

suite("the MIDI file, played", async (t) => {
  const all = parseSMF(fs.readFileSync(path.join(ROOT, "midi", "out", "tract-all.mid")));
  const timing = JSON.parse(fs.readFileSync(path.join(ROOT, "midi", "timing.json"), "utf8"));
  const starts = [];
  let clock = 0;
  timing.cues.forEach((cue) => (starts.push(clock), (clock += cue.seconds)));

  // all eight, as the rig is: the two seats on a part draw their cell lengths
  // independently, so one waiting at the end of a pass is covered by the
  // other — with one seat a part, a 3 s hole showed up that the rig would not have
  const who = ["I", "II", "III", "IV"].flatMap((part, i) => [1, 2].map((seat) => ({ part, seat, id: String(i + 1), track: i * 2 + seat })));
  const pages = [];
  for (const w of who) pages.push(await t.player({ part: w.part, seat: w.seat, query: `&midich=${w.track}`, audio: true }));
  t.note(`playing ${(clock / 60).toFixed(1)} minutes into ${pages.length} windows…`);

  const begin = Date.now() + 1500;
  const played = await Promise.all(
    pages.map((page, i) =>
      page.evaluate(
        async ([events, begin]) => {
          const samples = [];
          let k = 0;
          await new Promise((done) => {
            const id = setInterval(() => {
              const now = (Date.now() - begin) / 1000;
              while (k < events.length && events[k][0] <= now) window.scan.handleMIDI(events[k++].slice(1));
              if (!samples.length || now - samples[samples.length - 1].t >= 0.25) {
                samples.push({
                  t: now,
                  gate: /gate <b>on/.test(document.getElementById("readout").innerHTML),
                  whisper: !!window.scan.whisper,
                  phrase: window.scan.phrase,
                  mode: window.scan.transport.mode,
                  note: Math.round(window.scan.note),
                  pedal: window.scan.pedalDown,
                });
              }
              if (k >= events.length && now > events[events.length - 1][0] + 1) clearInterval(id), done();
            }, 5);
          });
          return samples;
        },
        [all.tracks[who[i].track].events.map((e) => [e.tick / all.division, e.kind | (e.channel - 1), e.d1, e.d2]), begin]
      )
    )
  );

  t.section("cue by cue, each window: gate open %, whisper at start and end (w), P for pedal, ! for the wrong phrase");
  console.log(`              ${who.map((w) => `${w.part}-${w.seat}`.padEnd(6)).join(" ")}`);
  const expected = {}; // the phrase each part should be on, from timing.json
  let wrong = 0;
  timing.cues.forEach((cue, i) => {
    const from = starts[i];
    const to = from + cue.seconds;
    const row = who.map((w, p) => {
      const block = (cue.parts || {})[w.id];
      if (block && block.go !== undefined) expected[w.id] = block.go === 0 ? -1 : block.go;
      const s = played[p].filter((x) => x.t >= from + 0.3 && x.t < to);
      if (!s.length) return `${w.part}: —`;
      const open = Math.round((100 * s.filter((x) => x.gate).length) / s.length);
      const end = s[s.length - 1];
      const ok = expected[w.id] === undefined || end.phrase === expected[w.id];
      if (!ok) wrong++;
      const modes = [...new Set(s.map((x) => x.mode).filter(Boolean))].join("/");
      return `${String(open).padStart(3)}${s[0].whisper ? "w" : "·"}${end.whisper ? "w" : "·"}${ok ? "" : "!"}${s.some((x) => x.pedal) ? "P" : " "}`;
    });
    console.log(`  ${String(cue.id).padStart(2)} ${String(Math.round(from)).padStart(4)}s  ${row.map((c) => c.padEnd(6)).join(" ")}  ${cue.label}`);
  });
  t.check(wrong === 0, "every window ends every cue on the phrase timing.json puts it on", `${wrong} wrong`);

  const n = Math.min(...played.map((p) => p.length));
  const rests = [];
  let since = null;
  for (let i = 0; i < n; i++) {
    const any = played.some((p) => p[i].gate);
    const at = played[0][i].t;
    if (!any && since === null) since = at;
    if (any && since !== null) rests.push([since, at]), (since = null);
  }
  const long = rests.filter(([a, b]) => a > 0 && b - a > 0.75);
  t.note(`everyone silent: ${long.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}s`).join("  ") || "never"}`);
  const worst = Math.max(0, ...long.map(([a, b]) => b - a));
  t.check(worst <= LONGEST_REST, "no silence longer than the score's own", `longest ${worst.toFixed(1)} s`);
});
