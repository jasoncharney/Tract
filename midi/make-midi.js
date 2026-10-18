#!/usr/bin/env node
/*
  midi/make-midi.js — the piece as eight MIDI tracks, for working out timing.

      node midi/make-midi.js --scaffold   write timing.json from cues.json
      node midi/make-midi.js              write the .mid files from timing.json

  WHY THIS EXISTS. The one thing the score does not say is how long anything
  lasts — that is the conductor's to decide, and it is hard to decide without
  hearing it. Eight laptops cannot be played by one person. So this writes a
  MIDI file in which each player is a track, each key press is a note, and the
  thing you are trying to find — the length of every cue — is a number in a
  text file you can edit.

  HOW THE TIMING IS EDITED. Two ways, and they are for different jobs.

    timing.json   one "seconds" per cue: the structure. Change a number, run
                  this again, hear the whole shape move. This is the file to
                  work in first.
    the DAW       drag the notes. Finer, and it does not survive a
                  regeneration — so do the big decisions in timing.json and
                  the nudging in the DAW.

  WHAT THE NOTES MEAN. The bottom two octaves are the player's keyboard, one
  note per key; a note's LENGTH is how long the key is held. From C1 up, notes
  set the pitch, as they always did. CC1 is the mouse on the strip: hold note
  13 for the button and draw CC1 for where it is.

      C-1   0  A   scan, slow          held
            1  S   scan, middle        held
            2  D   scan, fast          held
            3  W   one word, slow
            4  E   one word, middle
            5  R   one word, fast
            6  Q   a voiced phoneme    held
            7  T   a noisy one         held
            8  Z   whisper on / off
            9  space — the pedal       held
           10  the diminuendo
           11  esc — stop everything
      B-1  12  J   change pitch
           13  the mouse on the strip  held, with CC1
           15  standby
      C0   16  phrase 1   ...   23  phrase 8
      C1   24+ set the pitch, as before

  The file is written at 60 bpm with 480 ticks to the quarter, so one beat is
  one second and one 4/4 bar is four. Seconds in timing.json and the DAW's own
  grid are then the same ruler, which is the whole point of picking a daft
  tempo.
*/

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const SCAN = process.env.TRACT_SCAN || findScan();
const TIMING = path.join(HERE, "timing.json");
const OUT = path.join(HERE, "out");

function findScan() {
  // run from anywhere: walk up looking for the folder with cues.json in it
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    const guess = path.join(dir, "scan");
    if (fs.existsSync(path.join(guess, "cues.json"))) return guess;
    if (fs.existsSync(path.join(dir, "cues.json"))) return dir;
    dir = path.dirname(dir);
  }
  console.error("cannot find the scan folder — set TRACT_SCAN=/path/to/scan");
  process.exit(1);
}

const read = (f) => JSON.parse(fs.readFileSync(path.join(SCAN, f), "utf8"));

/* ================================================================ *
 *  who is playing
 * ================================================================ */

/* Two to a part, which is how it is rehearsed, and which is the only way to
 * hear the phrases where a part's pitches are shared out by seat — one player
 * on a two-pitch part leaves one of them silent. Channel is what tells the
 * eight browser windows apart. */
const PLAYERS = [
  { id: "I-1", part: "1", seat: 1, channel: 1 },
  { id: "I-2", part: "1", seat: 2, channel: 2 },
  { id: "II-1", part: "2", seat: 1, channel: 3 },
  { id: "II-2", part: "2", seat: 2, channel: 4 },
  { id: "III-1", part: "3", seat: 1, channel: 5 },
  { id: "III-2", part: "3", seat: 2, channel: 6 },
  { id: "IV-1", part: "4", seat: 1, channel: 7 },
  { id: "IV-2", part: "4", seat: 2, channel: 8 },
];

const KEYNOTE = {
  A: 0, S: 1, D: 2, W: 3, E: 4, R: 5, Q: 6, T: 7, Z: 8,
  space: 9, fade: 10, stop: 11, J: 12, mouse: 13, standby: 15,
  phrase1: 16, phrase2: 17, phrase3: 18, phrase4: 19,
  phrase5: 20, phrase6: 21, phrase7: 22, phrase8: 23,
};
const HELD = new Set(["A", "S", "D", "Q", "T", "space", "mouse"]);

/* ================================================================ *
 *  a repeatable kind of random
 *
 *  "Irregularly" has to mean irregular but the SAME irregular every time, or
 *  two renderings of the same timing.json cannot be compared and the thing is
 *  useless for deciding anything.
 * ================================================================ */

function rng(seedText) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

/* ================================================================ *
 *  A — the scaffold, read out of the cue text
 *
 *  Every cue names its keys in braces and says in words how often to press
 *  them. That is enough for a first draft and not enough for a final one, so
 *  each entry carries the sentence it came from and is yours to correct.
 * ================================================================ */

const CELLS = JSON.parse(fs.readFileSync(path.join(HERE, "phrase-cells.json"), "utf8"));

/**
 * How long a phoneme takes under each held key — read out of scan.js, not
 * copied here.
 *
 * These numbers are the single biggest thing deciding how long the piece
 * runs, and they get tuned by ear. A copy of them in this file would be wrong
 * the first time they changed, and wrong silently: the MIDI would still
 * generate, it would just no longer be the piece. So it reads the real table.
 */
const SCAN_SECS = (() => {
  const fallback = { A: 2, S: 0.5, D: 0.175 };
  try {
    const src = fs.readFileSync(path.join(SCAN, "src", "scan.js"), "utf8");
    const block = src.match(/const RATES = \{([\s\S]{0,400}?)\};/);
    if (!block) throw new Error("no RATES table");
    const pick = (name) => {
      const m = block[1].match(new RegExp(`${name}:\\s*\\[\\s*([\\d.]+)\\s*,\\s*([\\d.]+)`));
      if (!m) throw new Error(`no ${name} rate`);
      return (Number(m[1]) + Number(m[2])) / 2; // the middle of the range
    };
    const got = { A: pick("slow"), S: pick("mid"), D: pick("fast") };
    console.log(
      `scan rates from scan.js: A ${got.A}s, S ${got.S}s, D ${got.D}s per phoneme`
    );
    return got;
  } catch (e) {
    console.log(`could not read the rates from scan.js (${e.message}) — using ${JSON.stringify(fallback)}`);
    return fallback;
  }
})();

/** roughly how long one pass of a held scan takes on this phrase */
function passLength(phrase, key) {
  const cells = (CELLS[String(phrase)] || {}).cells || 12;
  return Math.round(cells * (SCAN_SECS[key] || 0.5) * 10) / 10;
}

/**
 * Which stretch of the strip a sweep covers, 0 to 1.
 *
 * The cue quotes the words it wants in single quotes. Matching them against
 * the phrase gives a word range, and words are close enough to even along the
 * strip for a timing sketch — the page itself lays cells out by weight, so
 * this is near but not exact, and a sweep you care about is worth nudging by
 * hand afterwards.
 */
function sweepRange(text, phrase) {
  const whole = [0, 1];
  const said = (CELLS[String(phrase)] || {}).text;
  if (!said) return whole;
  const quoted = text.match(/'([^']{2,60})'/);
  if (!quoted) return whole;
  const words = said.toLowerCase().replace(/[^a-z' ]/g, "").split(/\s+/).filter(Boolean);
  const want = quoted[1].toLowerCase().replace(/[^a-z' ]/g, "").split(/\s+/).filter(Boolean);
  if (!want.length) return whole;
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((w, j) => words[i + j] === w)) {
      return [
        Math.round((i / words.length) * 1000) / 1000,
        Math.round(((i + want.length) / words.length) * 1000) / 1000,
      ];
    }
  }
  // a quoted fragment that is not a run of whole words — "the last [n] in
  // 'strain'" — is one word, so sweep up to the end of it
  const one = words.indexOf(want[want.length - 1]);
  if (one > -1) return [Math.round((one / words.length) * 1000) / 1000, 1];
  return whole;
}

function scaffold() {
  const cues = read("cues.json").cues || [];
  const parts = read("parts.json").parts || [];
  const doc = {
    _: "Edit 'seconds' to change how long a cue runs — that is the whole point of this file. 'events' is a first draft read out of the cue text; 'from' is the sentence it came from, so you can see what was guessed. Then: node midi/make-midi.js",
    tempo: 60,
    spread: 0.15,
    _spread: "seconds of scatter between the two players on a part, so they are not in robotic unison. 0 to line them up exactly.",
    cues: [],
  };

  const held = {}; // part -> the key it is currently holding, across cues
  cues.forEach((cue, index) => {
    const entry = {
      id: String(cue.id || index + 1),
      phrase: cue.phrase || null,
      label: cue.label || "",
      seconds: 12,
      parts: {},
    };
    parts.forEach((p) => {
      const block = (cue.parts || {})[String(p.id)];
      if (!block || !block.instruction) return;
      entry.parts[String(p.id)] = {
        from: block.instruction,
        events: derive(block.instruction, cue, held, String(p.id)),
      };
    });
    // A first guess at the length, so the first render sounds like something
    // rather than like everything cut off. A cue that asks for a held scan
    // cannot be shorter than one pass of it — phrase 3 held on A is most of a
    // minute — and a cue nobody plays is a breath, not a section. These are
    // the numbers you are here to change.
    let longest = 0;
    Object.values(entry.parts).forEach((block) =>
      block.events.forEach((e) => {
        if (typeof e.hold === "number") longest = Math.max(longest, e.hold);
      })
    );
    if (Object.keys(entry.parts).length === 0) entry.seconds = 6;
    else if (longest > 0) entry.seconds = Math.round(longest + 4);
    doc.cues.push(entry);
  });
  return doc;
}

/**
 * One instruction, turned into events. Deliberately simple-minded: it reads
 * the braces for which keys, and a handful of words for how often. Where it
 * cannot tell, it leaves a single press at the top of the cue, which is wrong
 * in an obvious way rather than a subtle one.
 */
function derive(text, cue, held, partId) {
  const out = [];
  const keys = [...text.matchAll(/\{([^}]{1,12})\}/g)].map((m) => m[1]);
  const has = (re) => re.test(text);
  const phrase = cue.phrase || 1;

  // going somewhere: always first, and the rest of the cue happens there
  keys.forEach((k) => {
    if (/^[1-8]$/.test(k) && /Phrase \{/.test(text)) out.push({ k: `phrase${k}`, at: 0 });
    if (k === "0") out.push({ k: "standby", at: 0 });
  });

  // the pedal is the one thing that survives a cue boundary
  if (/Release \{space\}/.test(text) && held[partId] === "space") {
    held[partId] = null; // the hold started in an earlier cue; it ends here
    // "Release once silent" comes after the diminuendo, not before it
    out.push({ k: "_releaseSpace", at: /once silent|when silent/.test(text) ? "rest" : 0 });
  }
  if (/hold with \{space\}|Hold \{space\}/.test(text)) {
    held[partId] = "space";
    out.push({ k: "space", at: 1.5, hold: "rest" });
  }

  if (keys.includes("↓")) out.push({ k: "fade", at: 0.5 });
  if (/^Stop|Silence/.test(text)) out.push({ k: "stop", at: 0 });

  // the mouse: "sweep" and "scan ... with the mouse" are a curve, not a key.
  // A cue that quotes the words it wants — "sweep slowly through 'under the
  // burden'" — gets a curve across those words only, not the whole strip,
  // which is the difference between the cue and a different cue.
  if (/[Ss]weep|with your mouse/.test(text)) {
    out.push({ k: "mouse", at: 1, hold: "rest", sweep: sweepRange(text, phrase) });
  }

  // held scans, re-pressed at the end of each pass
  ["A", "S", "D"].forEach((k) => {
    if (!keys.includes(k)) return;
    const pass = passLength(phrase, k);
    out.push({ k, from: 1, to: "rest", every: [pass + 0.6, pass + 1.6], hold: pass });
  });

  // one-shot words
  ["W", "E", "R"].forEach((k) => {
    if (!keys.includes(k)) return;
    if (has(/once/)) out.push({ k, at: 1 });
    if (has(/quickly and irregular/)) out.push({ k, from: 4, to: "rest", every: [0.35, 0.9] });
    else if (has(/steady pulse/)) out.push({ k, from: 1, to: "rest", every: 2.2 });
    else if (has(/irregular/)) out.push({ k, from: 1, to: "rest", every: [0.9, 2.4] });
    else if (!has(/once/)) out.push({ k, from: 1, to: "rest", every: [1.2, 2.6] });
  });

  // the percussive keys
  ["Q", "T"].forEach((k) => {
    if (!keys.includes(k)) return;
    const quick = has(/quickly|rapid/);
    out.push({
      k,
      from: 1,
      to: "rest",
      every: quick ? [0.2, 0.6] : [0.7, 1.8],
      hold: 0.12,
    });
  });

  if (keys.includes("Z")) {
    if (has(/short bursts|on and off/)) {
      out.push({ k: "Z", from: 1, to: "rest", every: [1.4, 3.2] });
    } else {
      out.push({ k: "Z", at: 0.4 });
    }
  }
  if (keys.includes("J")) {
    out.push({ k: "J", from: 2, to: "rest", every: has(/from time to time/) ? [6, 12] : [3, 7] });
  }

  if (out.length === 0) out.push({ k: "_nothing", at: 0 });
  return out;
}

/* ================================================================ *
 *  B — events into notes
 * ================================================================ */

/** expand one event into [{note, at, hold}] within a cue of this length */
function expand(event, cueSeconds, random) {
  const span = (v) => (v === "rest" ? cueSeconds : Number(v) || 0);
  const notes = [];
  const holdOf = (fallback) =>
    event.hold === "rest" ? null : event.hold === undefined ? fallback : Number(event.hold);

  if (event.k === "_nothing" || event.k === "_releaseSpace") return notes;
  const note = KEYNOTE[event.k];
  if (note === undefined) return notes;
  const isHeld = HELD.has(event.k);
  const base = isHeld ? 0.4 : 0.08;

  const push = (at) => {
    let hold = holdOf(base);
    if (hold === null) hold = Math.max(0.2, cueSeconds - at - 0.2); // "rest" = to the end
    if (at >= cueSeconds) return;
    notes.push({ note, at, hold: Math.min(hold, cueSeconds - at - 0.05) });
  };

  if (event.at !== undefined) {
    push(Number(event.at) || 0);
    return notes;
  }
  const from = span(event.from === undefined ? 0 : event.from);
  const to = span(event.to === undefined ? "rest" : event.to);
  const every = event.every === undefined ? 1 : event.every;
  let t = from;
  let guard = 0;
  while (t < to && guard++ < 2000) {
    push(t);
    const gap = Array.isArray(every) ? every[0] + random() * (every[1] - every[0]) : Number(every) || 1;
    t += Math.max(0.05, gap);
  }
  return notes;
}

/* ================================================================ *
 *  C — the MIDI file itself
 * ================================================================ */

const PPQ = 480; // at 60 bpm this is 480 ticks to the second

function varint(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}
const str = (s) => [...Buffer.from(s, "utf8")];

/* A meta event's length is in BYTES, and the text here is not ASCII — the cue
 * markers are full of "·", which is one character and two bytes. Measuring it
 * with String.length writes a length one short per middle dot, and every byte
 * after that point is read as something else. */
const meta = (type, text) => {
  const bytes = str(text);
  return [0xff, type, ...varint(bytes.length), ...bytes];
};

function chunk(tag, bytes) {
  const len = bytes.length;
  return Buffer.from([...str(tag), (len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...bytes]);
}

/** events as {tick, bytes}; sorted and delta-encoded into one MTrk */
function track(events, name) {
  const body = [];
  body.push(...varint(0), ...meta(0x03, name));
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let last = 0;
  events.forEach((e) => {
    body.push(...varint(Math.max(0, Math.round(e.tick - last))), ...e.bytes);
    last = e.tick;
  });
  body.push(...varint(0), 0xff, 0x2f, 0x00);
  return chunk("MTrk", body);
}

function build(timing) {
  const bpm = Number(timing.tempo) || 60;
  const secToTick = (s) => (s * bpm * PPQ) / 60;
  const spread = Number(timing.spread) || 0;

  /* where every cue starts, and the markers that say so */
  const starts = [];
  let clock = 0;
  timing.cues.forEach((cue) => {
    starts.push(clock);
    clock += Math.max(0.2, Number(cue.seconds) || 0);
  });
  const total = clock;

  const conductor = [];
  conductor.push({
    tick: 0,
    order: 0,
    bytes: [0xff, 0x51, 0x03, ...[16, 8, 0].map((_, i) => [(60000000 / bpm) >> 16 & 255, (60000000 / bpm) >> 8 & 255, (60000000 / bpm) & 255][i])],
  });
  conductor.push({ tick: 0, order: 1, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] });
  timing.cues.forEach((cue, i) => {
    const text = `cue ${cue.id}${cue.phrase ? ` · ph ${cue.phrase}` : ""}${cue.label ? ` · ${cue.label}` : ""}`;
    conductor.push({ tick: secToTick(starts[i]), order: 2, bytes: meta(0x06, text) });
  });

  const tracks = PLAYERS.map((player) => {
    const events = [];
    const ch = (player.channel - 1) & 0x0f;
    let pedalOpenedAt = null;

    /* ---- the phrase lane ----
     *
     * Where this player is in the piece, drawn as one long note per phrase
     * rather than a blip at each change. Two reasons. In the piano roll it is
     * a bar you can see and drag, which is what you want when the question is
     * "should phrase 3 start later". And it is what makes skipping around in
     * the DAW work: a host that chases notes retriggers the bar you land
     * inside, and CC20 carries the same thing for hosts that chase only
     * controllers. The page ignores either one when it is already on that
     * phrase, so both arriving is harmless. */
    const lane = [];
    timing.cues.forEach((cue, i) => {
      const block = (cue.parts || {})[player.part];
      if (!block || !Array.isArray(block.events)) return;
      block.events.forEach((e) => {
        const m = /^phrase([1-8])$/.exec(e.k);
        if (!m && e.k !== "standby") return;
        const phrase = e.k === "standby" ? 0 : Number(m[1]);
        const at = starts[i] + (Number(e.at) || 0);
        if (lane.length) lane[lane.length - 1].to = at;
        lane.push({ phrase, from: at, to: total });
      });
    });
    lane.forEach((seg) => {
      const note = seg.phrase === 0 ? KEYNOTE.standby : KEYNOTE[`phrase${seg.phrase}`];
      const until = Math.max(seg.from + 0.2, seg.to - 0.05);
      events.push({ tick: secToTick(seg.from), order: -2, bytes: [0xb0 | ch, 20, seg.phrase] });
      events.push({ tick: secToTick(seg.from), order: -1, bytes: [0x90 | ch, note, 100] });
      events.push({ tick: secToTick(until), order: 2000, bytes: [0x80 | ch, note, 0] });
    });

    timing.cues.forEach((cue, i) => {
      const block = (cue.parts || {})[player.part];
      const t0 = starts[i];
      const seconds = Math.max(0.2, Number(cue.seconds) || 0);
      // the two players on a part are not a machine: nudge one of them
      const jitter = spread === 0 ? 0 : (player.seat - 1.5) * spread;
      if (!block || !Array.isArray(block.events)) return;
      const random = rng(`${cue.id}|${player.id}`);

      block.events.forEach((event, n) => {
        // the phrase lane above already drew these, as held notes
        if (/^phrase[1-8]$/.test(event.k) || event.k === "standby") return;
        if (event.k === "_releaseSpace" && pedalOpenedAt !== null) {
          // close a pedal that was opened in an earlier cue. "rest" means at
          // the end of this cue — "release once silent" comes after the
          // diminuendo, not at the downbeat that starts it.
          const when = event.at === "rest" ? t0 + seconds - 0.1 : t0 + (Number(event.at) || 0);
          events.push({ tick: secToTick(when), order: 0, bytes: [0x80 | ch, KEYNOTE.space, 0] });
          pedalOpenedAt = null;
          return;
        }
        expand(event, seconds, random).forEach((hit) => {
          const at = Math.max(0, t0 + hit.at + (hit.at > 0 ? jitter : 0));
          const off = at + Math.max(0.05, hit.hold);
          if (event.k === "space" && event.hold === "rest") {
            // leave it open: a later cue's "Release {space}" closes it
            events.push({ tick: secToTick(at), order: n, bytes: [0x90 | ch, hit.note, 100] });
            pedalOpenedAt = at;
            return;
          }
          events.push({ tick: secToTick(at), order: n, bytes: [0x90 | ch, hit.note, 100] });
          events.push({ tick: secToTick(off), order: 1000 + n, bytes: [0x80 | ch, hit.note, 0] });
          // a sweep draws its curve under the held note
          if (event.sweep) {
            const [a, b] = event.sweep;
            const steps = Math.max(2, Math.round((off - at) * 8));
            for (let s = 0; s <= steps; s++) {
              const k = s / steps;
              events.push({
                tick: secToTick(at + (off - at) * k),
                order: 500 + s,
                bytes: [0xb0 | ch, 1, Math.round((a + (b - a) * k) * 127)],
              });
            }
          }
        });
      });
    });

    if (pedalOpenedAt !== null) {
      events.push({ tick: secToTick(total), order: 9999, bytes: [0x80 | ch, KEYNOTE.space, 0] });
    }
    return { player, buf: track(events, `${player.id} (ch ${player.channel})`), count: events.length };
  });

  const header = (n) => chunk("MThd", [0, 1, (n >> 8) & 255, n & 255, (PPQ >> 8) & 255, PPQ & 255]);
  const all = Buffer.concat([
    header(tracks.length + 1),
    track(conductor, "conductor"),
    ...tracks.map((t) => t.buf),
  ]);
  const singles = tracks.map((t) => ({
    player: t.player,
    count: t.count,
    buf: Buffer.concat([header(2), track(conductor, "conductor"), t.buf]),
  }));
  return { all, singles, starts, total };
}

/* ================================================================ *
 *  running it
 * ================================================================ */

const WANT_SCAFFOLD = process.argv.includes("--scaffold");

if (WANT_SCAFFOLD || !fs.existsSync(TIMING)) {
  if (fs.existsSync(TIMING) && WANT_SCAFFOLD) {
    const backup = TIMING.replace(/\.json$/, `.${Date.now()}.json`);
    fs.copyFileSync(TIMING, backup);
    console.log(`your timing.json was kept as ${path.basename(backup)}`);
  }
  fs.writeFileSync(TIMING, JSON.stringify(scaffold(), null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), TIMING)} — edit the "seconds", then run this again`);
  if (WANT_SCAFFOLD) process.exit(0);
}

const timing = JSON.parse(fs.readFileSync(TIMING, "utf8"));
const { all, singles, starts, total } = build(timing);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "tract-all.mid"), all);
singles.forEach((s) => fs.writeFileSync(path.join(OUT, `tract-${s.player.id}.mid`), s.buf));

/* what you actually want to see: where the time goes */
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const byPhrase = new Map();
timing.cues.forEach((cue, i) => {
  const key = cue.phrase || "—";
  byPhrase.set(key, (byPhrase.get(key) || 0) + Math.max(0.2, Number(cue.seconds) || 0));
});
console.log(`\n${timing.cues.length} cues · ${PLAYERS.length} players · ${mmss(total)} total\n`);
console.log("  phrase   length   running");
let run = 0;
byPhrase.forEach((secs, phrase) => {
  run += secs;
  console.log(`    ${String(phrase).padStart(2)}     ${mmss(secs).padStart(5)}    ${mmss(run)}`);
});
console.log(`\n  out/tract-all.mid        ${(all.length / 1024).toFixed(0)} kB, ${PLAYERS.length} tracks + markers`);
singles.forEach((s) =>
  console.log(`  out/tract-${s.player.id}.mid`.padEnd(27) + `${s.count} events, channel ${s.player.channel}`)
);
console.log("\nwindows to open, one per track:");
PLAYERS.forEach((p) =>
  console.log(`  ch ${String(p.channel).padStart(2)}  /scan/?part=${["", "I", "II", "III", "IV"][Number(p.part)]}&seat=${p.seat}&midich=${p.channel}`)
);
console.log(
  "\n?midich= both turns MIDI on and sets the channel. A bare ?midi turns it on\n" +
    "and lets you pick the channel in the part panel. Without either, the window\n" +
    "is an ordinary player's page and knows nothing about MIDI."
);
void starts;
