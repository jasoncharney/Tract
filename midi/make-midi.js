#!/usr/bin/env node
/*
  midi/make-midi.js — the piece as eight MIDI tracks, for working out timing.

      node midi/make-midi.js        write the .mid files from timing.json

  WHY THIS EXISTS. The one thing the score does not say is how long anything
  lasts — that is the conductor's to decide, and it is hard to decide without
  hearing it. Eight laptops cannot be played by one person. So this writes a
  MIDI file in which each player is a track, each key press is a note, and the
  thing you are trying to find — the length of every cue — is a number in a
  text file you can edit.

  HOW A PART PLAYS. A part does what it was last told until a cue speaks to
  it again. That is how the piece is built — parts enter one after another
  and pile up — and it is the thing the first version of this got wrong: every
  gesture stopped at the end of its own cue, so each entry was a solo and
  every cue nobody spoke in was silence.

  So each part has lanes, and a lane changes only when that part's own block
  says something about it: the sound (a scan, words, a sweep, a hold), the
  whisper, the pitch, J, the pedal. A block that mentions only the whisper
  leaves the sound running underneath it.

  HOW THE TIMING IS EDITED. Two ways, and they are for different jobs.

    timing.json   one "seconds" per cue: the structure, plus a reading of
                  each instruction. Change a number, run this again, hear the
                  whole shape move. This is the file to work in first.
    the DAW       drag the notes. Finer, and it does not survive a
                  regeneration — so do the big decisions in timing.json and
                  the nudging in the DAW.

  WHAT THE NOTES MEAN. The bottom two octaves are the player's keyboard, one
  note per key; a note's LENGTH is how long the key is held.

      C-1   0  A   scan, slow          held
            1  S   scan, middle        held
            2  D   scan, fast          held
            3  W   one word, slow
            4  E   one word, middle
            5  R   one word, fast
            6  Q   a voiced phoneme    held
            7  T   a noisy one         held
            8  Z   whisper on / off    (a toggle: not written by this file)
            9  space — the pedal       held
           10  the diminuendo
           11  esc — stop everything
      B-1  12  J   change pitch
           13  the mouse on the strip  held, with CC1
           14  whisper                 held: whispering for as long as it lasts
           15  standby
      C0   16  phrase 1   ...   23  phrase 8
      C1   24+ set the pitch and open the gate, as a keyboard does

      CC1   where the mouse is on the strip
      CC20  which phrase — 0 standby, 1–8
      CC21  the pitch, as a MIDI note number — the gate is left alone

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

/* The wall is not a player — no pitches, no keyboard — but it is sequenced
 * the same way, on the channel after the eight. One note per cue that carries
 * a "stage" block in cues.json, note 24 + that cue's place in the list, held
 * until the next one so a host that chases notes leaves the wall in the state
 * the moment you land on is actually in. scan/src/stage.js reads it when the
 * page is opened with ?midich=. */
const STAGE = { id: "stage", part: "stage", seat: 0, channel: 9 };
const STAGE_NOTE_FROM = 24;

const NOTE = {
  A: 0, S: 1, D: 2, W: 3, E: 4, R: 5, Q: 6, T: 7, Z: 8,
  space: 9, fade: 10, stop: 11, J: 12, mouse: 13, whisper: 14, standby: 15,
  phrase1: 16,
};
/* Sweeps written longer than the slot they are given. A ramp that runs past
 * the end of its segment is cut off mid-drag, so the player never reaches the
 * position the sweep was aiming at — which matters most for exactly these
 * gestures, the ones told to arrive somewhere and hold. Collected while
 * rendering and reported once at the end, per cue and part rather than per
 * player, since both seats hit it the same way. */
const OVERRUNS = new Map();

const CC_MOUSE = 1;
const CC_PHRASE = 20;
const CC_PITCH = 21;

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
  const next = () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
  // a number, or a [lo, hi] range to pick inside
  next.pick = (v, fallback = 1) =>
    Array.isArray(v) ? v[0] + next() * (v[1] - v[0]) : v === undefined ? fallback : Number(v);
  return next;
}

/* ================================================================ *
 *  how long things take, from the page's own numbers
 * ================================================================ */

/* Where things are on each phrase's strip and how wide each cell is, measured
 * off a real page. CC1 is a position in cells, so this is also where a sweep
 * lands. */
const CELLS = JSON.parse(fs.readFileSync(path.join(HERE, "phrase-cells.json"), "utf8"));

/**
 * The scan and word rates — read out of scan.js, not copied here.
 *
 * These numbers are the single biggest thing deciding how long the piece
 * runs, and they get tuned by ear. A copy of them in this file would be wrong
 * the first time they changed, and wrong silently: the MIDI would still
 * generate, it would just no longer be the piece. So it reads the real tables.
 */
function readRates(name, fallback) {
  try {
    const src = fs.readFileSync(path.join(SCAN, "src", "scan.js"), "utf8");
    const block = src.match(new RegExp(`const ${name} = \\{([\\s\\S]{0,400}?)\\};`));
    if (!block) throw new Error(`no ${name} table`);
    const pick = (rate) => {
      const m = block[1].match(new RegExp(`${rate}:\\s*\\[\\s*([\\d.]+)\\s*,\\s*([\\d.]+)`));
      if (!m) throw new Error(`no ${rate} rate in ${name}`);
      return [Number(m[1]), Number(m[2])];
    };
    return { slow: pick("slow"), mid: pick("mid"), fast: pick("fast") };
  } catch (e) {
    console.log(`could not read ${name} from scan.js (${e.message}) — using ${JSON.stringify(fallback)}`);
    return fallback;
  }
}
const RATES = readRates("RATES", { slow: [1, 3], mid: [0.25, 0.75], fast: [0.1, 0.25] });
const SHOT_RATES = readRates("SHOT_RATES", { slow: [0.8, 1.6], mid: [0.25, 0.75], fast: [0.1, 0.25] });
const mean = ([lo, hi]) => (lo + hi) / 2;
const RATE_OF = { A: "slow", S: "mid", D: "fast", W: "slow", E: "mid", R: "fast" };
const r3 = (n) => Math.round(n * 1000) / 1000;
console.log(`scan rates from scan.js: A ${r3(mean(RATES.slow))}s, S ${r3(mean(RATES.mid))}s, D ${r3(mean(RATES.fast))}s per phoneme`);
console.log(`word rates from scan.js: W ${r3(mean(SHOT_RATES.slow))}s, E ${r3(mean(SHOT_RATES.mid))}s, R ${r3(mean(SHOT_RATES.fast))}s per phoneme`);

const strip = (phrase) => (CELLS[String(phrase)] || CELLS["1"]).strip;

/**
 * One pass of a held scan, end to end: how long it should take, and how far
 * either side of that it lands. The page draws every cell's length at random
 * inside the rate's range, so a pass is a sum of uniform draws — and holding
 * for the mean alone lets go of half the passes early and leaves the other
 * half sitting silent at the end waiting for the next press.
 */
function passLength(phrase, key) {
  const [lo, hi] = RATES[RATE_OF[key]];
  const widths = strip(phrase).map((c) => c[2]);
  const expected = widths.reduce((a, w) => a + w, 0) * mean([lo, hi]);
  const sd = Math.sqrt(widths.reduce((a, w) => a + w * w, 0)) * ((hi - lo) / Math.sqrt(12));
  return { expected, sd };
}

/** each word's length under a one-shot key, in strip order */
function wordLengths(phrase, key) {
  const widths = [];
  strip(phrase).forEach(([, word, width]) => {
    if (word < 0) return;
    widths[word] = (widths[word] || 0) + width;
  });
  return widths.filter((w) => w !== undefined).map((w) => w * mean(SHOT_RATES[RATE_OF[key]]));
}

/* W/E/R plays the next word, or a random one — per phrase, in the presets.
 * In order, the generator knows which word each press gets and waits for a
 * long word ("imprecision") instead of cutting it off. */
const PRESETS = (() => {
  try {
    return read("presets.json");
  } catch (e) {
    return {};
  }
})();
const wordModeOf = (phrase) => ((PRESETS[String(phrase - 1)] || {}).wordMode === "random" ? "random" : "next");

/* ================================================================ *
 *  B — a timing.json part block, into notes
 *
 *  Times inside a block, all relative to the moment the cue reaches this
 *  player (its start, nudged by the seat's spread):
 *
 *    0     let go: the pedal, and whatever the last sound was holding
 *    0.1   go to a phrase — or at "goAt"
 *    0.2   whisper, when the block both moves phrase and sets it
 *    0.3   the new sound, pitch and J, when anything above happened first;
 *          otherwise at 0. "soundAt" overrides.
 *
 *  The gaps are a few frames on the page. They are there because a phrase
 *  change stops the transport, so a scan that started before it would be
 *  stopped by it.
 * ================================================================ */

function renderPlayer(player, timing, starts, total, spread, unison = new Set(), jitter = 0) {
  const ch = (player.channel - 1) & 0x0f;
  const events = [];
  // order at a shared tick: note offs, then controllers, then note ons — so a
  // sweep's first position is in place before the mouse goes down, and a key
  // re-pressed on the same tick is let go first
  const off = (t, note) => events.push({ t, order: 0, bytes: [0x80 | ch, note, 0] });
  const cc = (t, number, value) =>
    events.push({ t, order: 1, bytes: [0xb0 | ch, number, Math.max(0, Math.min(127, Math.round(value)))] });
  const on = (t, note) => events.push({ t, order: 2, bytes: [0x90 | ch, note, 100] });
  const tap = (t, note, length = 0.08) => (on(t, note), off(t + length, note));

  /* every block this player's part is given, with its moments worked out */
  const blocks = [];
  timing.cues.forEach((cue, i) => {
    const block = (cue.parts || {})[player.part];
    if (!block) return;
    const nudge = block.together || spread === 0 ? 0 : (player.seat - 1.5) * spread;
    const t = starts[i] + Math.max(0, nudge);
    const moves = block.go !== undefined && block.goAt === undefined;
    const settles = moves || typeof block.whisper === "boolean";
    /* A unison sweep is several people trying to move together, not one
     * gesture played four times. Each player gets a lead of their own and a
     * speed of their own, so the entry has a soft edge and the release is as
     * ragged as the attack — which is what the cue sheet is actually asking
     * for when it says "listen to the other players and stay together".
     *
     * The lead runs from 0 to 2*jitter rather than -jitter to +jitter, so the
     * players are spread by the full ±jitter around each other while none of
     * them starts before the cue. Starting early is not free here: the lane
     * before this one lets go only 30 ms ahead of the block, so a sweep that
     * began before its own cue would overlap the gesture it replaces.
     *
     * It draws from a seed of its own, not from b.random, so switching this
     * on moves nothing else in the file. */
    // one knob turns the whole thing off, speed variation included
    const swept = jitter > 0 && unison.has(i);
    const roll = rng(`sweep|${cue.id}|${player.id}`);
    const lead = swept ? jitter * (1 + (2 * roll() - 1)) : 0;
    const stretch = swept ? 1 + (2 * roll() - 1) * 0.04 : 1;
    blocks.push({
      cue,
      block,
      t,
      lead,
      stretch,
      random: rng(`${cue.id}|${player.id}`),
      goAt: t + (block.goAt !== undefined ? Number(block.goAt) : 0.1),
      whisperAt: t + (moves ? 0.2 : 0),
      act: t + (block.soundAt !== undefined ? Number(block.soundAt) : settles ? 0.3 : 0),
    });
  });

  /* ---- the phrase lane ----
   *
   * One long note per phrase rather than a blip at each change, plus CC20.
   * In the piano roll it is a bar you can see and drag; and it is what makes
   * skipping around in the DAW work: a host that chases notes retriggers the
   * bar you land inside, and CC20 carries the same thing for hosts that chase
   * only controllers. The page ignores either one when it is already there. */
  const phrases = blocks.filter((b) => b.block.go !== undefined).map((b) => ({ t: b.goAt, phrase: Number(b.block.go) }));
  phrases.forEach((seg, i) => {
    const to = i + 1 < phrases.length ? phrases[i + 1].t : total;
    const note = seg.phrase === 0 ? NOTE.standby : NOTE.phrase1 + seg.phrase - 1;
    cc(seg.t, CC_PHRASE, seg.phrase);
    on(seg.t, note);
    off(Math.max(seg.t + 0.2, to - 0.05), note);
  });
  const phraseAt = (t) => {
    let p = 1;
    phrases.forEach((seg) => seg.t <= t + 1e-6 && (p = seg.phrase || p));
    return p;
  };

  /* ---- the lanes that run until replaced ---- */
  // `lets` is when the next block in this lane ends the one before it
  const lane = (key, when, lets = when) =>
    blocks
      .filter((b) => b.block[key] !== undefined)
      .map((b) => ({ ...b, at: when(b), letsGo: lets(b), spec: b.block[key] }))
      .map((e, i, list) => ({ ...e, until: i + 1 < list.length ? list[i + 1].letsGo : total }));

  const wordPresses = []; // when each word starts and ends, for "after each word"

  /* sound */
  // The old sound lets go the moment this part is spoken to — before the
  // phrase change, not after it. Letting a sweep run on to the new sound's
  // start sent its last CC1s after the phrase had changed, and dragged the
  // new phrase's playhead half way along before its first scan began.
  lane("sound", (b) => b.act, (b) => (b.block.soundAt !== undefined ? b.act : b.t)).forEach((e) => {
    const segments = Array.isArray(e.spec) ? e.spec : [e.spec];
    // only an object has an "at" of its own: "stop".at is String.prototype.at,
    // a function, and Number() of it put NaN into the timeline
    const offset = (seg) => (seg && typeof seg === "object" && seg.at !== undefined ? Number(seg.at) : 0);
    segments.forEach((seg, k) => {
      const t0 = e.at + offset(seg);
      const next = segments[k + 1];
      const t1 = next ? e.at + offset(next) : e.until;
      sound(seg, t0, t1, phraseAt(t0), e.random, e);
    });
  });

  function sound(spec, t0, t1, phrase, random, e) {
    const end = t1 - 0.03; // anything held lets go just before the next thing
    if (spec === null || spec === undefined || end <= t0) return;
    if (spec === "stop") return tap(t0, NOTE.stop);

    if (spec.scan) {
      const key = NOTE[spec.scan];
      if (spec.once) {
        on(t0, key);
        off(Math.min(end, spec.secs ? t0 + Number(spec.secs) : end), key);
        return;
      }
      // "When you reach the end, press it again." The pass is random on the
      // page, so the press cannot know where the end is. Let go too early and
      // the press only finishes the old pass — then sits silent for a whole
      // hold, which a played-through run showed: 18 s of nothing from Part I
      // in cues 4-5. Too late only means waiting at the end, which is what
      // the score describes. So: 2.2 standard deviations past the mean, which
      // a pass outlasts about one time in seventy.
      const { expected, sd } = passLength(phrase, spec.scan);
      const hold = expected + 2.2 * sd;
      // A new scan starts from the top of the strip. Pressed where the last
      // gesture left the playhead, its first press only finished the old
      // pass and then waited out a whole hold — IV changing from A to S in
      // cue 30 sounded half the cue. "continue" is "finish the scan you are on".
      if (!spec.continue) cc(t0, CC_MOUSE, 0);
      for (let t = t0; t < end - 0.2; ) {
        on(t, key);
        off(Math.min(end, t + hold), key);
        t += hold + random.pick([0.1, 0.3]);
      }
      return;
    }

    if (spec.words) {
      const key = spec.words;
      const lengths = wordLengths(phrase, key);
      const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const inOrder = wordModeOf(phrase) === "next";
      let cursor = -1;
      for (let t = t0; t < end - 0.05; ) {
        cursor = (cursor + 1) % lengths.length;
        const length = inOrder ? lengths[cursor] : mean;
        tap(t, NOTE[key]);
        wordPresses.push({ t, end: t + length });
        if (spec.jAfter) tap(t + length + 0.05, NOTE.J);
        if (spec.once) return;
        t += spec.gap !== undefined ? length + random.pick(spec.gap) : random.pick(spec.every, 1);
      }
      return;
    }

    if (spec.shots) {
      for (let t = t0; t < end - 0.05; t += random.pick(spec.every, 1)) {
        on(t, NOTE[spec.shots]);
        off(Math.min(end, t + random.pick(spec.hold, 0.12)), NOTE[spec.shots]);
      }
      return;
    }

    if (spec.hold !== undefined) {
      cc(t0, CC_MOUSE, Number(spec.hold) * 127);
      on(t0, NOTE.mouse);
      off(end, NOTE.mouse);
      return;
    }

    if (spec.sweep) {
      const [a, b] = spec.sweep;
      // the mouse moving, drawn as a CC1 curve ten points a second
      const ramp = (from, to, start, secs) => {
        const steps = Math.max(2, Math.round(secs * 10));
        for (let s = 0; s <= steps; s++) {
          const t = start + (secs * s) / steps;
          if (t > end) break;
          cc(t, CC_MOUSE, (from + ((to - from) * s) / steps) * 127);
        }
        return start + secs;
      };
      const mode = spec.mode || "once";
      if (mode === "once") {
        // in unison, this player's own moment and own speed; alone, zero and one
        const lead = (e && e.lead) || 0;
        const stretch = (e && e.stretch) || 1;
        const start = t0 + lead;
        const written = random.pick(spec.secs, 4);
        let secs = written * stretch;
        // the slot is measured without the jitter: this is a question about
        // what timing.json asks for, not about what the scatter did to it
        const slot = t1 - 0.03 - t0;
        if (written > slot + 1e-6) {
          const key = `${e && e.cue ? e.cue.id : "?"}|${player.part}`;
          if (!OVERRUNS.has(key)) OVERRUNS.set(key, { written, slot });
        }
        // A stretched sweep must still arrive: these are the ones told to
        // "hold on the last [n]", and a ramp cut off by the end of the block
        // never gets there. Only the jittered ones are clamped — a sweep
        // written longer than its own block is a timing.json question, and
        // silently shortening it here would hide it.
        if (lead || stretch !== 1) secs = Math.min(secs, Math.max(0.2, end - start - 0.05));
        cc(start, CC_MOUSE, a * 127);
        on(start, NOTE.mouse);
        const done = ramp(a, b, start, secs);
        off(spec.then === "hold" ? end : Math.min(end, done + 0.3), NOTE.mouse);
      } else if (mode === "loop") {
        // again and again, lifting the mouse to go back to the start
        for (let t = t0; t < end - 0.5; ) {
          const secs = random.pick(spec.secs, 4);
          cc(t, CC_MOUSE, a * 127);
          on(t, NOTE.mouse);
          const done = ramp(a, b, t, secs);
          off(Math.min(end, done + 0.15), NOTE.mouse);
          t = done + random.pick([0.3, 0.7]);
        }
      } else {
        // pingpong: back and forth across the range; wander: anywhere inside
        // it, sometimes one word and sometimes all of it, faster and slower
        cc(t0, CC_MOUSE, a * 127);
        on(t0, NOTE.mouse);
        let here = a;
        let t = t0;
        let toward = b;
        while (t < end - 0.3) {
          let there = toward;
          let secs = random.pick(spec.secs, 2);
          if (mode === "wander") {
            there = a + random() * (b - a);
            secs *= Math.max(0.3, Math.abs(there - here) / Math.max(0.01, b - a));
          }
          t = ramp(here, there, t, secs);
          if (mode === "wander" && random() < 0.3) t += random.pick([0.2, 0.9]); // a breath, still held
          here = there;
          toward = toward === b ? a : b;
        }
        off(end, NOTE.mouse);
      }
      return;
    }
  }

  /* whisper, as a held note 14 — the page sets the state, never flips it */
  const whispering = []; // [from, to] spans
  let state = false;
  let since = 0;
  const set = (t, value) => {
    if (value === state) return;
    if (value) since = t;
    else whispering.push([since, t]);
    state = value;
  };
  lane("whisper", (b) => b.whisperAt).forEach((e) => {
    const spec = e.spec;
    if (spec === true || spec === false) return set(e.at, spec);
    if (spec === "steady") return; // stop the bursts, keep whatever the base was
    if (spec.bursts) {
      // single voiced notes breaking out of the whisper: short gaps in it
      set(e.at, true);
      for (let t = e.at + e.random.pick(spec.bursts); t < e.until - 0.5; t += e.random.pick(spec.bursts)) {
        const length = e.random.pick(spec.len, 0.4);
        set(t, false);
        set(Math.min(e.until - 0.1, t + length), true);
        t += length;
      }
      return;
    }
    if (spec.voiced) {
      // "more and more of your sound voiced, until you are fully voiced": the
      // voiced gaps grow and the whispered ones shrink, then it stays voiced
      const by = Math.min(e.until, e.at + Number(spec.voiced));
      set(e.at, true);
      for (let t = e.at + 0.5; t < by - 0.3; ) {
        const k = (t - e.at) / (by - e.at);
        const voiced = 0.25 + k * 1.6;
        set(t, false);
        t += voiced;
        if (t >= by - 0.3) break;
        set(t, true);
        t += Math.max(0.15, 1.4 * (1 - k));
      }
      set(by, false);
    }
  });
  if (state) whispering.push([since, total]);
  whispering.forEach(([a, b]) => {
    if (b - a < 0.05) return;
    on(a, NOTE.whisper);
    off(b, NOTE.whisper);
  });

  /* pitch, as CC21 — a note number, without touching the gate */
  lane("pitch", (b) => b.act).forEach((e) => {
    const spec = e.spec;
    const span = e.until - e.at;
    if (spec === "stay" || span <= 0) return;
    if (spec.set !== undefined) return cc(e.at, CC_PITCH, spec.set);
    if (spec.slide || spec.widen) {
      for (let t = e.at; t < e.until - 0.1; t += e.random.pick(spec.every, 1.5)) {
        const k = (t - e.at) / span;
        const [lo, hi] = spec.slide || [
          spec.widen[0][0] + k * (spec.widen[1][0] - spec.widen[0][0]),
          spec.widen[0][1] + k * (spec.widen[1][1] - spec.widen[0][1]),
        ];
        cc(t, CC_PITCH, lo + e.random() * (hi - lo));
      }
      return;
    }
    if (spec.drift) {
      // little by little, a semitone at a time, arriving at the end of the span
      const [from, to] = spec.drift;
      const steps = Math.abs(to - from);
      for (let s = 0; s <= steps; s++) cc(e.at + (span * s) / (steps + 1), CC_PITCH, from + Math.sign(to - from) * s);
      return;
    }
    if (spec.alternate) {
      // after every word, to the other one
      let k = 0;
      wordPresses
        .filter((w) => w.t >= e.at - 0.01 && w.t < e.until)
        .forEach((w) => cc(Math.min(e.until - 0.05, w.end + 0.05), CC_PITCH, spec.alternate[k++ % 2]));
      cc(e.at, CC_PITCH, spec.alternate[1]);
    }
  });

  /* J, from time to time */
  lane("j", (b) => b.act).forEach((e) => {
    if (!Array.isArray(e.spec)) return; // "stop"
    for (let t = e.at + e.random.pick(e.spec); t < e.until - 0.2; t += e.random.pick(e.spec)) tap(t, NOTE.J);
  });

  /* the pedal: down and up where the blocks say */
  let pedal = false;
  blocks
    .filter((b) => b.block.pedal)
    .forEach((b) => {
      // the hold at the end of a sweep is part of that sweep: if the player
      // was late starting, they are late reaching the last phoneme too
      const t = b.t + Number(b.block.pedalAt || 0) + (b.lead || 0);
      if (b.block.pedal === "down" && !pedal) on(t, NOTE.space);
      if (b.block.pedal === "up" && pedal) off(t, NOTE.space);
      pedal = b.block.pedal === "down";
    });
  if (pedal) off(total, NOTE.space);

  /* the diminuendo */
  blocks.filter((b) => b.block.fade !== undefined).forEach((b) => tap(b.t + Number(b.block.fade), NOTE.fade));

  return events;
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
    body.push(...varint(Math.max(0, e.tick - last)), ...e.bytes);
    last = e.tick;
  });
  body.push(...varint(0), 0xff, 0x2f, 0x00);
  return chunk("MTrk", body);
}

function build(timing) {
  const bpm = Number(timing.tempo) || 60;
  const secToTick = (s) => Math.round((s * bpm * PPQ) / 60);
  const spread = Number(timing.spread) || 0;
  // how far apart a unison sweep's players land, in seconds: see renderPlayer
  const jitter = timing.sweepJitter === undefined ? 0.08 : Number(timing.sweepJitter) || 0;

  /* Which cues are a unison sweep: more than one part making the same
   * one-shot sweep at the same moment. "loop" and "wander" sweeps are the
   * score telling players to go their own way — cue 24 says "on your own, at
   * your own speed" — and they already draw their own lengths, so they are
   * left alone. */
  const oneShotSweep = (block) => {
    const spec = block && block.sound;
    const segments = Array.isArray(spec) ? spec : [spec];
    return segments.some(
      (seg) => seg && typeof seg === "object" && seg.sweep && (seg.mode || "once") === "once"
    );
  };
  const unison = new Set();
  timing.cues.forEach((cue, i) => {
    if (Object.values(cue.parts || {}).filter(oneShotSweep).length > 1) unison.add(i);
  });

  /* where every cue starts, and the markers that say so */
  const starts = [];
  let clock = 0;
  timing.cues.forEach((cue) => {
    starts.push(clock);
    clock += Math.max(0.2, Number(cue.seconds) || 0);
  });
  const total = clock;

  const tempo = Math.round(60000000 / bpm);
  const conductor = [
    { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] },
    { tick: 0, order: 1, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
  ];
  timing.cues.forEach((cue, i) => {
    const text = `cue ${cue.id}${cue.phrase ? ` · ph ${cue.phrase}` : ""}${cue.label ? ` · ${cue.label}` : ""}`;
    conductor.push({ tick: secToTick(starts[i]), order: 2, bytes: meta(0x06, text) });
  });

  const tracks = PLAYERS.map((player) => {
    const rendered = renderPlayer(player, timing, starts, total, spread, unison, jitter);
    // One NaN time breaks the sort, and a track out of order is not a
    // malformed file — it parses, every delta clamped at zero, and the piece
    // quietly runs twice as long with half of it in the wrong place.
    const bad = rendered.find((e) => !isFinite(e.t) || e.bytes.some((b) => !Number.isInteger(b)));
    if (bad) throw new Error(`${player.id}: an event with no proper time or value — ${bad.t} [${bad.bytes}]`);
    const events = rendered.map((e) => ({
      tick: secToTick(Math.max(0, Math.min(total, e.t))),
      order: e.order,
      bytes: e.bytes,
    }));
    return { player, buf: track(events, `${player.id} (ch ${player.channel})`), count: events.length };
  });

  /* ---- the stage's own track ----
   *
   * The drawings are built and updating on the wall from the moment a player
   * feeds it, but #wall sits at opacity 0 behind the title card until a cue
   * says "tracts": true — and in a simulation there is no conductor to say
   * it. Without this track a run looks like nothing connected, when in fact
   * everything did. */
  const stageChannel = (STAGE.channel - 1) & 0x0f;
  const stageBlocks = timing.cues
    .map((cue, i) => ({ i, t: starts[i], block: ((score[i] || {}).stage) }))
    .filter((x) => x.block && typeof x.block === "object");
  const stageEvents = [];
  stageBlocks.forEach((seg, k) => {
    const to = k + 1 < stageBlocks.length ? stageBlocks[k + 1].t : total;
    const note = STAGE_NOTE_FROM + seg.i;
    stageEvents.push({ tick: secToTick(seg.t), order: 2, bytes: [0x90 | stageChannel, note, 100] });
    stageEvents.push({
      tick: secToTick(Math.max(seg.t + 0.2, to - 0.05)),
      order: 0,
      bytes: [0x80 | stageChannel, note, 0],
    });
  });
  const stageTrack = {
    player: STAGE,
    count: stageEvents.length,
    buf: track(stageEvents, `stage (ch ${STAGE.channel})`),
  };

  const header = (n) => chunk("MThd", [0, 1, (n >> 8) & 255, n & 255, (PPQ >> 8) & 255, PPQ & 255]);
  const all = Buffer.concat([
    header(tracks.length + 2),
    track(conductor, "conductor"),
    ...tracks.map((t) => t.buf),
    stageTrack.buf,
  ]);
  const singles = [...tracks, stageTrack].map((t) => ({
    player: t.player,
    count: t.count,
    buf: Buffer.concat([header(2), track(conductor, "conductor"), t.buf]),
  }));
  return { all, singles, starts, total };
}

/* ================================================================ *
 *  running it
 * ================================================================ */

if (process.argv.includes("--scaffold")) {
  console.log(
    "--scaffold is gone: timing.json is a reading of the score now, written by\n" +
      "hand, and a scaffold guessed from the cue text would overwrite it. Edit it."
  );
  process.exit(1);
}

const timing = JSON.parse(fs.readFileSync(TIMING, "utf8"));

/* a reading of a cue that has since been rewritten is a reading of a
 * different cue — say so rather than playing the old one quietly */
const score = read("cues.json").cues || [];
timing.cues.forEach((cue, i) => {
  const now = score[i];
  if (!now) return console.log(`! timing.json has a cue ${cue.id} that cues.json no longer does`);
  Object.entries(cue.parts || {}).forEach(([part, block]) => {
    const said = ((now.parts || {})[part] || {}).instruction;
    if (block.from && said !== block.from) console.log(`! cue ${cue.id}, part ${part}: the instruction has changed since timing.json read it`);
  });
  Object.keys(now.parts || {}).forEach((part) => {
    if (!(cue.parts || {})[part]) console.log(`! cue ${cue.id}, part ${part}: an instruction timing.json has no reading of`);
  });
});
if (score.length > timing.cues.length) console.log(`! cues.json has ${score.length - timing.cues.length} cue(s) timing.json does not`);

const { all, singles, total } = build(timing);
OVERRUNS.forEach(({ written, slot }, key) => {
  const [cue, part] = key.split("|");
  console.log(
    `! cue ${cue}, part ${part}: a ${written}s sweep in a ${slot.toFixed(2)}s slot — ` +
      `the drag is cut off ${(100 * (1 - slot / written)).toFixed(0)}% short of where it was aimed`
  );
});
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "tract-all.mid"), all);
singles.forEach((s) => fs.writeFileSync(path.join(OUT, `tract-${s.player.id}.mid`), s.buf));

/* what you actually want to see: where the time goes */
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const byPhrase = new Map();
timing.cues.forEach((cue) => {
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
console.log(`\n  out/tract-all.mid        ${(all.length / 1024).toFixed(0)} kB, ${PLAYERS.length} tracks + stage + markers`);
singles.forEach((s) =>
  console.log(`  out/tract-${s.player.id}.mid`.padEnd(27) + `${s.count} events, channel ${s.player.channel}`)
);
console.log("\nwindows: node midi/testers.js opens all eight and the wall, or by hand:");
PLAYERS.forEach((p) =>
  console.log(`  ch ${String(p.channel).padStart(2)}  /scan/?part=${["", "I", "II", "III", "IV"][Number(p.part)]}&seat=${p.seat}&midich=${p.channel}`)
);
console.log(`  ch ${String(STAGE.channel).padStart(2)}  /scan/stage.html?midich=${STAGE.channel}`);
