/*
  scan/src/scan.js — page glue: audio, strip UI, transports.
  The articulation logic lives in engine.js; the worklet repair in
  patched-pink-trombone.js.
*/

import { ScanVoice, buildTrack, DEFAULTS, OPEN } from "./engine.js";
import { loadPatchedPinkTrombone } from "./patched-pink-trombone.js";

/** bump alongside the ?v= in index.html; printed on load so there is never a
 *  question about which build a browser is actually running */
const BUILD = "2026-09-18d";

const $ = (id) => document.getElementById(id);
const strip = $("strip");
const cursor = $("cursor");
const ipaLine = $("ipaLine");
const altsHost = $("alts");
const readout = $("readout");
const controlsHost = $("controls");

const cfg = Object.assign({}, DEFAULTS);

const SEARCH = new URLSearchParams(location.search);
const NO_PATCH = SEARCH.has("nopatch");
const PATCH_NAMES = SEARCH.has("patches") ? SEARCH.get("patches").split(",") : null;

// `phonemes` is a top-level `const` inside src/utils.js, so it lives in the
// global *lexical* environment and never appears on `window`
function phonemeTable() {
  if (typeof phonemes !== "undefined" && phonemes) return phonemes;
  return window.phonemes || {};
}

/* ================================================================ *
 *  the phrases
 * ================================================================ */

const PHRASES = [
  "words strain",
  "CRACK",
  "and sometimes break under the burden",
  "under the tension",
  "slip, slide, perish",
  "decay with imprecision",
  "will not stay in place",
  "will not stay still",
];

// not in the CMU dictionary; built from its own "precision" (pɹisɪˈʒʌn)
const WORD_IPA = {
  imprecision: "ɪmpɹisɪˈʒʌn",
};

let phraseIndex = 0;

// four parts, at least two players each. Loaded from parts.json; this is the
// fallback so the page still works if the file is missing.
const DEFAULT_PARTS = [
  { id: "1", name: "I", tractDelta: -6, phrases: [] },
  { id: "2", name: "II", tractDelta: -2, phrases: [] },
  { id: "3", name: "III", tractDelta: 2, phrases: [] },
  { id: "4", name: "IV", tractDelta: 8, phrases: [] },
];
let parts = DEFAULT_PARTS;
let partsDoc = {}; // whatever else parts.json carries — the _comment, mainly — so
// that writing the file back does not quietly delete it
let partIndex = 0;

const part = () => parts[partIndex] || { tractDelta: 0, phrases: [] };
const partPhrase = () => {
  const p = part();
  return (p.phrases && p.phrases[phraseIndex]) || {};
};

/** "Eb3", "G#4", "A 2", 57.5 — all the same kind of thing */
const NAME_TO_SEMITONE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
function parsePitch(value) {
  if (typeof value === "number") return isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^-?[\d.]+$/.test(text)) return Number(text);
  const m = text.match(/^([A-Ga-g])\s*([#♯b♭]*)\s*(-?\d+)$/);
  if (!m) return null;
  let semitone = NAME_TO_SEMITONE[m[1].toLowerCase()];
  for (const ch of m[2]) semitone += ch === "#" || ch === "♯" ? 1 : -1;
  return semitone + (Number(m[3]) + 1) * 12;
}

/** the pitches this part may use in this phrase; empty means free choice */
function allowedNotes() {
  const list = partPhrase().notes;
  if (!Array.isArray(list)) return [];
  return list.map(parsePitch).filter((n) => n !== null && isFinite(n));
}

/* ----------------------------------------------------------------- *
 *  SCAN SPEEDS — tune these.
 *  Seconds per phoneme for the three held keys. A fresh value is drawn
 *  from the range for every cell, so two players on the same key drift
 *  apart. A cell's own width scales it: a narrow pass-through stop takes
 *  half as long as a vowel, a word gap about two thirds.
 * ----------------------------------------------------------------- */
const RATES = {
  slow: [3, 5], // A and W
  mid: [0.25, 0.75], // S and E
  fast: [0.1, 0.25], // D and R — near speaking tempo
};
const rand = (a, b) => a + Math.random() * (b - a);

/* ----------------------------------------------------------------- *
 *  VOICE DEFAULTS — tune these.
 *  These are what the page starts with, and they are what the sliders
 *  read on load. They are NOT the defaultValue fields in the worklet:
 *  those are overwritten the moment audio starts, so editing
 *  pink-trombone-worklet-processor.min.js has no effect here.
 *  A phrase preset, once saved, overrides all of them.
 * ----------------------------------------------------------------- */
const VOICE = {
  note: 45.5, // MIDI note, B♭2 ≈ 113 Hz. Fractions allowed.
  gain: 0.4, // output level, 0–1
  tractLength: 44, // 15–88; bigger = larger body, same pitch
  vibrato: {
    rate: 6, // Hz
    depth: 0.005, // 0 = no periodic vibrato
    wobble: 1, // 0 = dead steady pitch; 1 = the synth's own slow drift
  },
};

let ctx = null;
let element = null;
let voice = null;
let master = null;
let limiterNode = null;
let ready = false;

let cells = [];
let cellEls = [];
let rects = [];
let wordLabels = [];
let currentIpa = "";

let targetPos = 0.5;
let pressed = false; // pointer is down
let insideStrip = false;
let explicitGate = null; // null = follow the pointer, 0/1 = forced by OSC/MIDI
let lastGesture = "—";
let lastGestureAt = 0;
let note = VOICE.note;
let ws = null;

let gain = VOICE.gain;
const vibrato = Object.assign({}, VOICE.vibrato);
let wordMode = "next"; // or "random", per phrase
let wordSpans = [];
let spanWord = []; // span index -> index into words[]
let wordCursor = -1;
let pronunciation = "fixed"; // fixed | phrase | word
let lastSpanSeen = -1;
let atEnd = false; // the last scan ran off the end of the phrase
let whisperRestoreAt = 0;

/** keyboard transport: A S D hold to scan, Q W E R T are one-shots */
const transport = {
  mode: null, // null | "scan" | "word" | "phoneme" | "perc"
  rate: "mid",
  last: 0,
  cellIndex: -1,
  cellDur: 1,
  stopAt: 0,
  until: 0,
  key: null,
};

/* ================================================================ *
 *  audio
 * ================================================================ */

async function enableAudio() {
  if (ctx) {
    await ctx.resume();
    return;
  }
  ctx = new AudioContext();

  const { applied, missed } = await loadPatchedPinkTrombone({
    patch: !NO_PATCH,
    names: PATCH_NAMES,
  });
  if (missed.length) {
    console.warn(
      `Tract: ${applied.length}/${applied.length + missed.length} worklet patches applied. ` +
        `Could not apply: ${missed.join(", ")} — has the upstream source changed?`
    );
  } else {
    console.log(`Tract: all ${applied.length} worklet patches applied (${applied.join(", ")}).`);
  }

  element = document.createElement("pink-trombone");
  $("tractHost").appendChild(element);
  await element.setAudioContext(ctx);

  master = ctx.createGain();
  master.gain.value = gain;
  // Safety net. The burst transient is a sample-level impulse, which is faster
  // than any compressor attack, so the compressor handles the sustained level
  // and a tanh curve catches what gets past it.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.15;
  const softClip = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
  }
  softClip.curve = curve;
  softClip.oversample = "4x";
  element.connect(master);
  master.connect(limiter);
  limiter.connect(softClip);
  softClip.connect(ctx.destination);
  limiterNode = softClip;
  element.pinkTrombone.start();

  // newConstriction() marks a constriction taken only after a port round-trip,
  // so two synchronous calls hand back the *same* one — and then every frame
  // schedules two conflicting ramps on one parameter, which is what made the
  // constrictions twitch. Claim each one immediately.
  const front = element.newConstriction(41, OPEN);
  front._isEnabled = true;
  const back = element.newConstriction(10.5, OPEN);
  back._isEnabled = true;
  if (front === back) console.warn("scan: front and back constriction are the same node");

  voice = new ScanVoice(
    {
      tongueIndex: element.tongue.index,
      tongueDiameter: element.tongue.diameter,
      frontIndex: front.index,
      frontDiameter: front.diameter,
      backIndex: back.index,
      backDiameter: back.diameter,
      tenseness: element.tenseness,
      loudness: element.loudness,
      intensity: element.intensity,
      frequency: element.frequency,
      tractLength: element.tractLength,
      burst: element.burst,
      burstDecay: element.burstDecay,
    },
    cfg
  );
  voice.cfg = cfg; // share the object so the sliders write straight through
  voice.onGesture = (name) => {
    lastGesture = name;
    lastGestureAt = performance.now();
    sendOut("/scan/out/gesture", [name]);
  };
  voice.setTrack(cells);
  voice.setNote(note, ctx.currentTime, 0);
  voice.gate = 0;
  voice.params.intensity.value = 0;
  voice.invalidate();

  applyVibrato();
  master.gain.value = gain;

  showTract(true);

  ready = true;
  $("startAudio").textContent = "audio running";
  $("startAudio").classList.remove("primary");
  window.scan.voice = voice;
  window.scan.ctx = ctx;
  window.scan.element = element;
}

/* ================================================================ *
 *  phrase -> words -> IPA -> cells
 * ================================================================ */

let words = [];

function dictReady() {
  return (
    window.TextToIPA &&
    TextToIPA._IPADict &&
    Object.keys(TextToIPA._IPADict).length > 0
  );
}

function lookup(word) {
  if (WORD_IPA[word]) return [WORD_IPA[word]];
  if (!dictReady()) return [];
  return (TextToIPA._IPADict[word] || []).slice();
}

function setPhrase(index, { announce = true } = {}) {
  const count = PHRASES.length;
  phraseIndex = ((index % count) + count) % count;
  const phrase = PHRASES[phraseIndex];

  words = phrase
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const clean = token.toLowerCase().replace(/[^a-z']/g, "");
      return {
        token,
        word: clean,
        alts: lookup(clean),
        choice: 0,
        // a comma is a longer breath: it earns an extra gap cell
        pause: /[,;:.]$/.test(token),
      };
    });

  $("phraseNum").textContent = `${phraseIndex + 1}/${count}`;
  $("phraseText").textContent = phrase;
  paintDots();
  wordCursor = -1; // a new phrase starts from its first word
  applyPreset(phraseIndex); // brings this phrase's cfg, pitch and word choices
  if (pronunciation !== "fixed") randomizeChoices();
  renderAlts();
  rebuildFromWords();
  paintInstruction();
  lastSpanSeen = -1;
  wordCursor = -1;
  atEnd = false;
  targetPos = 0;
  if (announce) sendOut("/scan/out/phrase", [phraseIndex + 1, phrase]);
}

/** re-roll the pronunciation of one word, or of all of them */
function randomizeChoices(wordIndex) {
  // a straight uniform draw: forcing a change from last time makes a two-variant
  // word alternate on a fixed cycle instead of being random
  const roll = (w) => {
    if (w.alts.length < 2) return;
    w.choice = Math.floor(Math.random() * w.alts.length);
  };
  if (wordIndex === undefined) words.forEach(roll);
  else if (words[wordIndex]) roll(words[wordIndex]);
}

/** which span (word) a position falls in */
function spanAt(pos) {
  for (let i = 0; i < wordSpans.length; i++) {
    if (pos >= wordSpans[i].start && pos < wordSpans[i].end) return i;
  }
  return -1;
}

/** re-roll one word mid-performance and keep the scan where it was */
function rerollSpan(spanIndex) {
  if (spanIndex < 0 || spanIndex >= spanWord.length) return;
  const wordIndex = spanWord[spanIndex];
  if (!words[wordIndex] || words[wordIndex].alts.length < 2) return;
  randomizeChoices(wordIndex);
  rebuildFromWords();
  const span = wordSpans[spanIndex];
  if (span) targetPos = span.start + 0.02;
}

function rebuildFromWords() {
  const parts = [];
  wordLabels = [];
  spanWord = [];
  words.forEach((w, index) => {
    if (w.alts.length === 0) return;
    parts.push(w.alts[w.choice]);
    wordLabels.push(w.token);
    spanWord.push(index);
    if (w.pause) {
      parts.push(""); // an empty part between two spaces = a second gap cell
      wordLabels.push("");
    }
  });
  currentIpa = parts.join(" ");
  if (ipaLine) ipaLine.textContent = currentIpa;
  setTrack(currentIpa);
}

function renderAlts() {
  altsHost.innerHTML = "";
  const label = document.createElement("span");
  label.className = "alts-label";
  label.textContent = "pronunciation";
  altsHost.appendChild(label);

  const modeSel = document.createElement("select");
  modeSel.id = "pronunciationSel";
  [
    ["fixed", "as chosen"],
    ["phrase", "re-roll each phrase"],
    ["word", "re-roll each word"],
  ].forEach(([value, text]) => modeSel.appendChild(new Option(text, value)));
  modeSel.value = pronunciation;
  modeSel.addEventListener("input", () => {
    pronunciation = modeSel.value;
    if (pronunciation !== "fixed") {
      randomizeChoices();
      renderAlts();
      rebuildFromWords();
    }
  });
  altsHost.appendChild(modeSel);

  const variable = words.filter((w) => w.alts.length > 1);
  if (variable.length === 0) {
    const none = document.createElement("span");
    none.className = "alts-label";
    none.textContent = "· this phrase has no variants";
    altsHost.appendChild(none);
    return;
  }
  words.forEach((w) => {
    if (w.alts.length <= 1) return;
    const select = document.createElement("select");
    w.alts.forEach((alt, index) => {
      select.appendChild(new Option(`${w.word}: ${alt}`, String(index)));
    });
    select.value = String(w.choice);
    select.addEventListener("input", () => {
      w.choice = Number(select.value);
      rebuildFromWords();
    });
    altsHost.appendChild(select);
  });
}

function paintDots() {
  const host = $("phraseDots");
  host.innerHTML = "";
  PHRASES.forEach((phrase, i) => {
    const dot = document.createElement("button");
    dot.className = "dot" + (i === phraseIndex ? " on" : "");
    dot.title = phrase;
    dot.setAttribute("aria-label", phrase);
    dot.addEventListener("click", () => setPhrase(i));
    host.appendChild(dot);
  });
}

function setTrack(ipa) {
  cells = buildTrack(ipa, phonemeTable(), cfg);
  computeWordSpans();
  renderStrip();
  if (voice) voice.setTrack(cells);
  targetPos = Math.min(targetPos, Math.max(0.001, cells.length - 0.001));
}

/** the runs of non-silent cells, so a key can play exactly one word */
function computeWordSpans() {
  wordSpans = [];
  let start = null;
  cells.forEach((cell, i) => {
    if (cell.cls === "silence") {
      if (start !== null) {
        wordSpans.push({ start, end: i });
        start = null;
      }
    } else if (start === null) {
      start = i;
    }
  });
  if (start !== null) wordSpans.push({ start, end: cells.length });
  // NB: the word cursor is deliberately not reset here. Re-rolling a
  // pronunciation rebuilds the track mid-performance, and losing your place in
  // the phrase every time would leave W/E/R stuck on the first word.
  if (wordCursor >= wordSpans.length) wordCursor = wordSpans.length - 1;
}

/* ================================================================ *
 *  the strip
 * ================================================================ */

function cellTag(cell) {
  switch (cell.cls) {
    case "stop":
      return cell.passThrough ? "stop" : "hold";
    case "affricate":
      return "affr";
    case "fricative":
      return "fric";
    case "aspirate":
      return "asp";
    case "approximant":
      return "appr";
    case "silence":
      return "";
    default:
      return cell.cls;
  }
}

function renderStrip() {
  strip.innerHTML = "";
  strip.appendChild(cursor);
  cellEls = [];

  let group = null;
  let groupCells = null;
  let groupWord = -1;
  let groupWeight = 0;

  const closeGroup = () => {
    if (group) group.style.flex = String(groupWeight);
    group = null;
    groupCells = null;
    groupWeight = 0;
  };

  cells.forEach((cell) => {
    const standalone = cell.cls === "silence";
    if (!group || standalone || cell.wordIndex !== groupWord || groupWord === -1) {
      closeGroup();
      group = document.createElement("div");
      group.className = "word";
      const label = document.createElement("div");
      label.className = "wlabel";
      label.textContent = standalone ? "" : wordLabels[cell.wordIndex] || "";
      groupCells = document.createElement("div");
      groupCells.className = "cells";
      group.appendChild(label);
      group.appendChild(groupCells);
      strip.appendChild(group);
      groupWord = standalone ? -1 : cell.wordIndex;
    }

    const el = document.createElement("div");
    el.className = "cell";
    el.dataset.cls = cell.cls;
    if (cell.passThrough) el.dataset.pass = "1";
    if (cell.closes && cell.cls === "stop") el.dataset.hold = "1";
    el.style.flex = String(cell.width);
    el.title =
      `${cell.ipa} — ${cell.cls}` +
      (cell.passThrough ? " (passes through)" : cell.closes ? " (holds)" : "") +
      (cell.example ? ` · as in "${cell.example}"` : "");
    const onsets = (cell.onsets || []).map((c) => c.ipa).join("");
    const codas = (cell.codas || []).map((c) => c.ipa).join("");
    el.innerHTML =
      `<div class="bar"></div>` +
      `<span class="glyphs">` +
      (onsets ? `<span class="affix onset">${onsets}</span>` : "") +
      `<span class="ipa">${cell.ipa}</span>` +
      (codas ? `<span class="affix coda">${codas}</span>` : "") +
      `</span>` +
      `<span class="tag">${cellTag(cell)}</span>`;
    groupCells.appendChild(el);
    cellEls.push(el);
    groupWeight += cell.width;
  });
  closeGroup();

  requestAnimationFrame(measure);
}

function measure() {
  rects = cellEls.map((el) => el.getBoundingClientRect());
}
window.addEventListener("resize", measure);

function posFromX(x) {
  if (!rects.length) return 0;
  if (x < rects[0].left) return 0;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x < r.right || i === rects.length - 1) {
      const f = Math.max(0, Math.min(0.999, (x - r.left) / r.width));
      return i + f;
    }
  }
  return rects.length - 0.001;
}

function xFromPos(pos) {
  if (!rects.length) return 0;
  const i = Math.max(0, Math.min(rects.length - 1, Math.floor(pos)));
  const r = rects[i];
  return r.left + (pos - i) * r.width;
}

function withinStrip(event) {
  const r = strip.getBoundingClientRect();
  return (
    event.clientX >= r.left &&
    event.clientX <= r.right &&
    event.clientY >= r.top &&
    event.clientY <= r.bottom
  );
}

/* the gate follows the mouse button: sound only while held down on the strip */

strip.addEventListener("pointerdown", async (event) => {
  event.preventDefault();
  cancelTransport(); // taking hold of the strip overrides a running key
  strip.setPointerCapture(event.pointerId);
  pressed = true;
  insideStrip = true;
  strip.classList.add("live");
  measure();
  targetPos = posFromX(event.clientX);
  if (!ctx) await enableAudio();
  if (explicitGate === null) openGate(true);
});

strip.addEventListener("pointermove", (event) => {
  const inside = withinStrip(event);
  // a key transport owns the position while it runs: a trackpad nudge should
  // not yank the scan somewhere else mid-phrase
  if (transport.mode && !pressed) {
    insideStrip = inside;
    return;
  }
  targetPos = posFromX(event.clientX);
  if (pressed && inside !== insideStrip) {
    insideStrip = inside;
    if (explicitGate === null) openGate(inside);
    strip.classList.toggle("live", inside);
  } else {
    insideStrip = inside;
  }
});

const liftPointer = (event) => {
  if (!pressed) return;
  pressed = false;
  strip.classList.remove("live");
  if (event && event.pointerId !== undefined) {
    try {
      strip.releasePointerCapture(event.pointerId);
    } catch (e) {}
  }
  if (explicitGate === null) openGate(false);
};
strip.addEventListener("pointerup", liftPointer);
strip.addEventListener("pointercancel", liftPointer);
window.addEventListener("pointerup", liftPointer);
strip.addEventListener("pointerleave", () => {
  insideStrip = false;
  if (pressed && explicitGate === null) openGate(false);
});
strip.addEventListener("contextmenu", (e) => e.preventDefault());

function openGate(on) {
  if (!ready) return;
  if (on === voice.gate > 0) return;
  voice.setGate(on, ctx.currentTime);
}

/* ================================================================ *
 *  frame loop
 * ================================================================ */

let paintedCell = -1;
let paintedClosed = false;

function frame() {
  requestAnimationFrame(frame);
  if (!ready) return;

  const now = ctx.currentTime;
  tickTransport(now);
  if (whisperRestoreAt && now >= whisperRestoreAt) {
    whisperRestoreAt = 0;
    voice.setWhisper(presetWhisper, now);
    syncControl("whisper", presetWhisper);
  }
  voice.update(targetPos, now);

  const stripRect = strip.getBoundingClientRect();
  cursor.style.opacity = voice.gate > 0 ? "1" : "0.28";
  cursor.style.left = `${xFromPos(targetPos) - stripRect.left}px`;

  const i = voice.cellAt(targetPos);
  const closed = voice.closed && !voice.released;
  if (i !== paintedCell || closed !== paintedClosed) {
    cellEls.forEach((el, index) => {
      el.classList.toggle("active", index === i);
      el.classList.toggle("closed", index === i && closed);
    });
    if (i !== paintedCell) {
      const cell = cells[i];
      sendOut("/scan/out/cell", [i, cell ? cell.ipa : ""]);
    }
    paintedCell = i;
    paintedClosed = closed;
  }

  paintReadout(i);
}

let lastReadout = "";
function paintReadout(i) {
  const cell = cells[i];
  const fresh = performance.now() - lastGestureAt < 400;
  const kind = !cell
    ? "—"
    : cell.cls === "stop"
      ? cell.passThrough
        ? "stop · passes through"
        : "stop · holds"
      : cell.cls;
  const text =
    `pos <b>${targetPos.toFixed(2)}</b>` +
    ` · cell <b>${cell ? cell.ipa : "—"}</b> (${kind})` +
    ` · gesture <b style="color:${fresh ? "#ff7ab6" : "inherit"}">${lastGesture}</b>` +
    ` · note <b>${note.toFixed(2)}</b> = <b>${voice.frequency().toFixed(1)} Hz</b>` +
    ` · gate <b>${voice.gate > 0 ? "on" : "off"}</b>`;
  if (text !== lastReadout) {
    readout.innerHTML = text;
    lastReadout = text;
  }
}
requestAnimationFrame(frame);

/* ================================================================ *
 *  remote control — one entry point for every transport
 * ================================================================ */

function num(v, fallback = 0) {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

export function applyRemote(address, args = []) {
  const now = ctx ? ctx.currentTime : 0;
  const a0 = args[0];
  switch (address) {
    case "/scan/position":
      targetPos = Math.max(0, Math.min(cells.length - 0.001, num(a0)));
      if (explicitGate === null && !pressed) openGate(true);
      break;
    case "/scan/norm":
      targetPos = Math.max(0, Math.min(cells.length - 0.001, num(a0) * cells.length));
      if (explicitGate === null && !pressed) openGate(true);
      break;
    case "/scan/index":
      targetPos = Math.max(0, Math.min(cells.length - 0.001, Math.floor(num(a0)) + 0.5));
      if (explicitGate === null && !pressed) openGate(true);
      break;
    case "/scan/gate": {
      const on = num(a0) > 0.5;
      explicitGate = on ? 1 : 0;
      if (ready) voice.setGate(on, now);
      break;
    }
    case "/scan/auto":
      explicitGate = null;
      break;
    case "/scan/part":
      setPart(Math.round(num(a0, 1)) - 1);
      break;
    case "/scan/phrase":
      setPhrase(Math.round(num(a0, 1)) - 1);
      break;
    case "/scan/next":
      setPhrase(phraseIndex + 1);
      break;
    case "/scan/prev":
      setPhrase(phraseIndex - 1);
      break;
    case "/scan/note":
      note = num(a0, note);
      if (ready) voice.setNote(note, now);
      syncControl("note", note);
      paintPiano();
      paintNoteChoices();
      break;
    case "/scan/bend":
      if (ready) voice.setBend(num(a0), now);
      break;
    case "/scan/glide":
      cfg.glide = num(a0, cfg.glide);
      syncControl("glide", cfg.glide);
      break;
    case "/scan/text": {
      // still accepted from Max, for anything outside the phrase list
      const text = String(a0 ?? "");
      words = text
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => {
          const clean = token.toLowerCase().replace(/[^a-z']/g, "");
          return { token, word: clean, alts: lookup(clean), choice: 0, pause: /[,;:.]$/.test(token) };
        });
      $("phraseText").textContent = text;
      $("phraseNum").textContent = "—";
      renderAlts();
      rebuildFromWords();
      break;
    }
    case "/scan/phonemes":
      currentIpa = String(a0 ?? "");
      wordLabels = [];
      $("phraseText").textContent = String(a0 ?? "");
      $("phraseNum").textContent = "—";
      ipaLine.textContent = String(a0 ?? "");
      altsHost.innerHTML = "";
      setTrack(String(a0 ?? ""));
      break;
    case "/scan/param":
      if (typeof a0 === "string" && a0 in cfg) {
        cfg[a0] = typeof cfg[a0] === "boolean" ? num(args[1]) > 0.5 : num(args[1], cfg[a0]);
        syncControl(a0, cfg[a0]);
        if (a0 === "holdWordFinalStops") setTrack(currentIpa);
      }
      break;
    case "/scan/speed": {
      const k = Math.max(0.1, num(a0, 1));
      [
        "closeTime",
        "passClose",
        "burstTime",
        "votVoiceless",
        "votVoiced",
        "transition",
        "affricateClosure",
      ].forEach((key) => {
        cfg[key] = DEFAULTS[key] / k;
        syncControl(key, cfg[key]);
      });
      break;
    }
    case "/scan/tract":
      if (ready) voice.setTractLength(num(a0, 44), now);
      syncControl("tractLength", num(a0, 44));
      break;
    case "/scan/whisper":
      if (ready) voice.setWhisper(num(a0) > 0.5, now);
      syncControl("whisper", num(a0) > 0.5);
      break;
    case "/scan/gain":
      gain = num(a0, gain);
      if (master) master.gain.setTargetAtTime(gain, now, 0.02);
      syncControl("gain", gain);
      break;
    case "/scan/vibrato/rate":
      vibrato.rate = num(a0, vibrato.rate);
      applyVibrato();
      syncControl("vibratoRate", vibrato.rate);
      break;
    case "/scan/vibrato/depth":
      vibrato.depth = num(a0, vibrato.depth);
      applyVibrato();
      syncControl("vibratoDepth", vibrato.depth);
      break;
    case "/scan/vibrato/wobble":
      vibrato.wobble = num(a0, vibrato.wobble);
      applyVibrato();
      syncControl("wobble", vibrato.wobble);
      break;

    /* ---- from the conductor page; args are [cue, partId, instruction] ---- */
    case "/cue/prep":
      cuePrep(a0, args[1], String(args[2] ?? ""));
      break;
    case "/cue/count":
      cueCount(num(a0), args[1]);
      break;
    case "/cue/go":
      cueGo(a0, args[1], String(args[2] ?? ""));
      break;
    case "/cue/clear":
      cueClear(args[0]);
      break;
    case "/cue/state":
      cueState(a0, args[1], String(args[2] ?? ""));
      break;
    case "/cue/ping": // a conductor just opened: say who is here
      sayHello();
      break;
    default:
      break;
  }
}

function sendOut(address, args) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ address, args }));
  }
  if (window.max && window.max.outlet) {
    window.max.outlet(address, ...args);
  }
}

/* ---- WebSocket bridge ---- */

function connectWS() {
  const pill = $("wsStatus");
  const port = location.port || (location.protocol === "https:" ? 443 : 80);
  let url;
  try {
    url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${port}/`;
  } catch (e) {
    return;
  }
  try {
    ws = new WebSocket(url);
  } catch (e) {
    pill.textContent = "bridge: —";
    return;
  }
  ws.addEventListener("open", () => {
    pill.textContent = `bridge: ${location.hostname}:${port}`;
    pill.className = "pill on";
    sayHello(); // and every few seconds after, so the conductor's roster is live
  });
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (Array.isArray(message)) {
      message.forEach((m) => applyRemote(m.address, m.args));
    } else if (message && message.address) {
      applyRemote(message.address, message.args || []);
    }
  });
  ws.addEventListener("close", () => {
    pill.textContent = "bridge: offline";
    pill.className = "pill off";
    ws = null;
    setTimeout(connectWS, 2000);
  });
  ws.addEventListener("error", () => {});
}

/* ---- BroadcastChannel, so the other demos in this repo can drive it ---- */

function connectBroadcast() {
  try {
    const channel = new BroadcastChannel("pink-trombone");
    channel.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || !message.to || !message.to.includes("scan")) return;
      if (message.address) applyRemote(message.address, message.args || []);
      if (message.position !== undefined) applyRemote("/scan/position", [message.position]);
      if (message.phonemes !== undefined) applyRemote("/scan/phonemes", [message.phonemes]);
      if (message.text !== undefined) applyRemote("/scan/text", [message.text]);
      if (message.note !== undefined) applyRemote("/scan/note", [message.note]);
      if (message.gate !== undefined) applyRemote("/scan/gate", [message.gate]);
    });
  } catch (e) {
    /* no BroadcastChannel */
  }
}

/* ---- jweb (running inside Max) ---- */

function connectMax() {
  if (!window.max || !window.max.bindInlet) return;
  const bind = (name, address) =>
    window.max.bindInlet(name, (...args) => applyRemote(address, args));
  bind("position", "/scan/position");
  bind("norm", "/scan/norm");
  bind("index", "/scan/index");
  bind("gate", "/scan/gate");
  bind("phrase", "/scan/phrase");
  bind("next", "/scan/next");
  bind("prev", "/scan/prev");
  bind("note", "/scan/note");
  bind("bend", "/scan/bend");
  bind("text", "/scan/text");
  bind("phonemes", "/scan/phonemes");
  bind("param", "/scan/param");
  bind("speed", "/scan/speed");
  bind("tract", "/scan/tract");
  bind("whisper", "/scan/whisper");
  bind("gain", "/scan/gain");
}

/* ---- Web MIDI ---- */

async function connectMIDI() {
  if (!navigator.requestMIDIAccess) return "no Web MIDI in this browser";
  const access = await navigator.requestMIDIAccess();
  const names = [];
  access.inputs.forEach((input) => {
    names.push(input.name);
    input.onmidimessage = ({ data }) => {
      const [status, d1, d2] = data;
      const kind = status & 0xf0;
      if (kind === 0x90 && d2 > 0) {
        applyRemote("/scan/note", [d1]);
        applyRemote("/scan/gate", [1]);
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        applyRemote("/scan/gate", [0]);
      } else if (kind === 0xe0) {
        const bend = ((d2 << 7) | d1) / 8192 - 1;
        applyRemote("/scan/bend", [bend * 2]);
      } else if (kind === 0xb0 && d1 === 1) {
        applyRemote("/scan/norm", [d2 / 127]);
      }
    };
  });
  return names.length ? `MIDI: ${names.join(", ")}` : "MIDI: no inputs";
}

/* ================================================================ *
 *  controls
 * ================================================================ */

const CONTROLS = [
  { key: "closeTime", label: "closure time", min: 0.005, max: 0.15, step: 0.005, unit: "s" },
  { key: "passClose", label: "pass-through closure", min: 0.005, max: 0.1, step: 0.002, unit: "s" },
  { key: "burstTime", label: "burst", min: 0.002, max: 0.05, step: 0.001, unit: "s" },
  { key: "burstLevel", label: "burst strength", min: 0, max: 1, step: 0.01, unit: "" },
  { key: "burstDecay", label: "burst brightness", min: 50, max: 2000, step: 10, unit: "" },
  { key: "pressureVoiceless", label: "pressure behind p t k", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "votVoiceless", label: "VOT  p t k", min: 0, max: 0.15, step: 0.005, unit: "s" },
  { key: "votVoiced", label: "VOT  b d g", min: 0, max: 0.08, step: 0.002, unit: "s" },
  { key: "transition", label: "burst → next", min: 0.01, max: 0.2, step: 0.005, unit: "s" },
  { key: "affricateClosure", label: "affricate hold", min: 0.01, max: 0.2, step: 0.005, unit: "s" },
  { key: "smooth", label: "scan smoothing", min: 0.005, max: 0.15, step: 0.005, unit: "s" },
  { key: "blend", label: "transition zone", min: 0.05, max: 0.9, step: 0.05, unit: "" },
  { key: "glide", label: "pitch glide", min: 0, max: 0.5, step: 0.01, unit: "s" },
  { key: "note", label: "pitch (MIDI note)", min: 24, max: 84, step: 0.01, unit: "", special: true },
  { key: "tractLength", label: "tract length", min: 15, max: 88, step: 1, unit: "", special: true },
  { key: "gain", label: "output", min: 0, max: 1, step: 0.005, unit: "", special: true },
  { key: "vibratoRate", label: "vibrato rate", min: 0.1, max: 12, step: 0.1, unit: "", special: true },
  { key: "vibratoDepth", label: "vibrato depth", min: 0, max: 0.04, step: 0.001, unit: "", special: true },
  { key: "wobble", label: "wobble (pitch drift)", min: 0, max: 1, step: 0.01, unit: "", special: true },
  { key: "whisper", label: "whisper", toggle: true, special: true },
  { key: "holdWordFinalStops", label: "word-final stops wait to be left", toggle: true },
  { key: "autoReleaseStops", label: "held stops release themselves", toggle: true },
];

/** plain-language descriptions, shown on hover */
const HELP = {
  "closeTime": "How quickly the mouth closes when it arrives at a consonant it is going to hold. Longer feels more deliberate.",
  "passClose": "How long the mouth stays shut before a consonant pops open — the wind-up before a k, t or p. Very short.",
  "burstTime": "The length of the little explosion when a consonant lets go. Shorter is crisper.",
  "burstLevel": "How loud that explosion is. Down for a soft, breathy consonant; up for a sharp click.",
  "burstDecay": "The tone of the explosion. Higher is a short bright tick; lower is a deeper thump, like a balloon popping.",
  "pressureVoiceless": "How much air builds up behind a closed p, t or k before it opens. More gives a punchier release.",
  "votVoiceless": "The puff of breath between a p, t or k and the vowel after it. Longer sounds more aspirated, like a whispered h.",
  "votVoiced": "The same gap for b, d and g. Normally very short — that shortness is what makes them sound voiced rather than breathy.",
  "transition": "How long the mouth takes to travel from a released consonant into the vowel that follows it.",
  "affricateClosure": "How long ch and j stay shut before letting go into their hiss.",
  "smooth": "How closely the mouth follows your hand. Larger is smoother and more blurred; smaller is immediate, and can sound jumpy.",
  "blend": "How much of each block is spent gliding into the next. Small values give abrupt changes between sounds; large values are always sliding.",
  "glide": "How long the pitch takes to slide when the note changes. 0 jumps straight there.",
  "note": "The note being sung. Click the piano below to pick one, or drag here for pitches in between the keys.",
  "tractLength": "The size of the throat and mouth. Longer sounds like a bigger body — deeper and darker — without changing the note.",
  "gain": "How loud this voice is.",
  "vibratoRate": "How fast the pitch wavers, in wobbles per second.",
  "vibratoDepth": "How far the pitch wavers. 0 is a perfectly even note.",
  "wobble": "Slow, random drifting of the pitch — the natural unsteadiness of a real voice. 0 holds a dead-steady pitch, which is usually what a choir wants.",
  "holdWordFinalStops": "On: a consonant at the end of a word waits silently until you leave the word, then pops. Off: it happens as you arrive, taking no time.",
  "autoReleaseStops": "On: a consonant being held lets go by itself after a moment instead of waiting for you.",
  "whisper": "Sing with breath instead of voice — no pitch, just the shape of the words, like whispering."
};

const controlEls = {};

function buildControls() {
  // keep focus off the controls so the playback keys always reach the page
  controlsHost.addEventListener("pointerup", (event) => {
    const el = event.target;
    if (el && /^(INPUT|SELECT)$/.test(el.tagName)) setTimeout(() => el.blur(), 0);
  });
  controlsHost.addEventListener("change", (event) => {
    const el = event.target;
    if (el && el.blur) setTimeout(() => el.blur(), 0);
  });

  CONTROLS.forEach((spec) => {
    const wrap = document.createElement("div");
    wrap.className = "ctl" + (spec.toggle ? " toggle" : "");
    if (HELP[spec.key]) wrap.title = HELP[spec.key];
    const label = document.createElement("label");
    label.textContent = spec.label;
    const row = document.createElement("div");
    row.className = "row";

    if (spec.toggle) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = spec.special ? false : !!cfg[spec.key];
      input.addEventListener("input", () => onControl(spec, input.checked));
      row.appendChild(input);
      controlEls[spec.key] = input;
    } else {
      const input = document.createElement("input");
      input.type = "range";
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step;
      input.value = spec.special ? specialValue(spec.key) : cfg[spec.key];
      const out = document.createElement("output");
      out.textContent = formatValue(input.value, spec);
      input.addEventListener("input", () => {
        out.textContent = formatValue(input.value, spec);
        onControl(spec, Number(input.value));
      });
      row.appendChild(input);
      row.appendChild(out);
      controlEls[spec.key] = input;
      controlEls[spec.key + ":out"] = out;
    }

    wrap.appendChild(label);
    wrap.appendChild(row);
    controlsHost.appendChild(wrap);
  });
}

function specialValue(key) {
  if (key === "note") return note;
  if (key === "tractLength") return voice ? voice.tractLength : 44;
  if (key === "gain") return gain;
  if (key === "vibratoRate") return vibrato.rate;
  if (key === "vibratoDepth") return vibrato.depth;
  if (key === "wobble") return vibrato.wobble;
  return 0;
}

function formatValue(value, spec) {
  const n = Number(value);
  if (spec.unit === "s") return `${(n * 1000).toFixed(0)} ms`;
  if (spec.key === "vibratoRate") return `${n.toFixed(1)} Hz`;
  if (spec.key === "vibratoDepth") return n === 0 ? "off" : `${(n * 1731).toFixed(0)}¢`;
  if (spec.key === "note") return `${n.toFixed(2)}  ${pitchLabel(n)}`;
  return n.toFixed(2);
}

function onControl(spec, value) {
  if (!spec.special) {
    cfg[spec.key] = value;
    if (spec.key === "holdWordFinalStops") setTrack(currentIpa);
    return;
  }
  switch (spec.key) {
    case "note":
      applyRemote("/scan/note", [value]);
      break;
    case "tractLength":
      applyRemote("/scan/tract", [value]);
      break;
    case "gain":
      applyRemote("/scan/gain", [value]);
      break;
    case "whisper":
      presetWhisper = !!value;
      applyRemote("/scan/whisper", [value ? 1 : 0]);
      break;
    case "vibratoRate":
      vibrato.rate = value;
      applyVibrato();
      break;
    case "vibratoDepth":
      vibrato.depth = value;
      applyVibrato();
      break;
    case "wobble":
      vibrato.wobble = value;
      applyVibrato();
      break;
  }
}

function syncControl(key, value) {
  const el = controlEls[key];
  if (!el) return;
  if (el.type === "checkbox") {
    el.checked = !!value;
  } else {
    el.value = value;
    const out = controlEls[key + ":out"];
    const spec = CONTROLS.find((c) => c.key === key);
    if (out && spec) out.textContent = formatValue(value, spec);
  }
}

/* ================================================================ *
 *  recording — taps the master output and writes a .wav
 * ================================================================ */

let recorder = null;

function startRecording() {
  if (!ready || recorder) return false;
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  node.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    event.outputBuffer.getChannelData(0).fill(0);
  };
  limiterNode.connect(node);
  node.connect(ctx.destination);
  recorder = { node, chunks, sampleRate: ctx.sampleRate };
  $("record").textContent = "stop recording";
  $("record").classList.add("primary");
  return true;
}

function collectRecording() {
  if (!recorder) return null;
  const { chunks, sampleRate, node } = recorder;
  try {
    limiterNode.disconnect(node);
  } catch (e) {}
  node.disconnect();
  node.onaudioprocess = null;
  recorder = null;
  $("record").textContent = "record";
  $("record").classList.remove("primary");

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return { samples, sampleRate };
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function stopRecordingAndDownload() {
  const take = collectRecording();
  if (!take) return;
  const url = URL.createObjectURL(encodeWav(take.samples, take.sampleRate));
  const link = document.createElement("a");
  link.href = url;
  link.download = `scan-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ================================================================ *
 *  keyboard transport
 *
 *  A S D are held: the position advances by itself at slow / mid / fast,
 *  a fresh duration drawn per phoneme, and the gate closes when you let go —
 *  keeping the position, so the next press carries on from there.
 *  Q W E R T are one-shots.
 * ================================================================ */

/** stop whatever the keys were doing, without touching the gate twice */
function cancelTransport() {
  if (!transport.mode) return;
  transport.mode = null;
  transport.key = null;
  restoreWhisper();
  paintTransport();
}

/**
 * The percussion key borrows the voice and makes it unvoiced. If anything else
 * starts before it has handed the voice back — press T then Q — the restore was
 * being orphaned and everything stayed whispered. Every start goes through here.
 */
function restoreWhisper() {
  whisperRestoreAt = 0;
  if (ready && voice.whisper !== presetWhisper) {
    voice.setWhisper(presetWhisper, ctx.currentTime);
    syncControl("whisper", presetWhisper);
  }
}

/** Z: breath instead of voice, and back. Latching, so it survives T and Q. */
function toggleWhisper() {
  whisperRestoreAt = 0; // whatever the percussion key was going to hand back
  presetWhisper = !presetWhisper;
  syncControl("whisper", presetWhisper);
  applyRemote("/scan/whisper", [presetWhisper ? 1 : 0]);
  lastGesture = presetWhisper ? "whisper on" : "whisper off";
  lastGestureAt = performance.now();
  sendOut("/scan/out/gesture", [lastGesture]);
}

function startScan(rateName, key) {
  if (!ready || pressed) return;
  restoreWhisper();
  if (atEnd || targetPos >= cells.length - 0.01) {
    targetPos = 0;
    atEnd = false;
  }
  transport.mode = "scan";
  transport.rate = rateName;
  transport.key = key;
  transport.last = ctx.currentTime;
  transport.cellIndex = -1;
  explicitGate = null;
  openGate(true);
  paintTransport();
}

function stopScan(key) {
  if (transport.mode !== "scan") return;
  if (key && transport.key && key !== transport.key) return;
  transport.mode = null;
  transport.key = null;
  openGate(false);
  paintTransport();
}

/** which word a W/E/R press should play: the next one, or a random one */
function pickWord() {
  if (wordSpans.length === 0) return null;
  if (wordMode === "random") {
    let i = Math.floor(Math.random() * wordSpans.length);
    if (wordSpans.length > 1 && i === wordCursor) i = (i + 1) % wordSpans.length;
    wordCursor = i;
  } else {
    wordCursor = (wordCursor + 1) % wordSpans.length;
  }
  return wordSpans[wordCursor];
}

function startWord(rateName) {
  if (!ready || pressed) return;
  restoreWhisper();
  let span = pickWord();
  if (!span) return;
  if (pronunciation === "word") {
    rerollSpan(wordCursor);
    span = wordSpans[wordCursor] || span;
  }
  transport.mode = "word";
  transport.rate = rateName;
  transport.last = ctx.currentTime;
  transport.cellIndex = -1;
  transport.stopAt = span.end;
  targetPos = span.start + 0.02;
  explicitGate = null;
  openGate(true);
  paintTransport();
}

function startRandomPhoneme() {
  if (!ready || pressed) return;
  restoreWhisper();
  const candidates = cells
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.cls !== "silence");
  if (candidates.length === 0) return;
  const { i } = candidates[Math.floor(Math.random() * candidates.length)];
  targetPos = i + 0.5;
  transport.mode = "phoneme";
  transport.until = ctx.currentTime + rand(0.35, 0.9);
  explicitGate = null;
  openGate(true);
  paintTransport();
}

/** a percussive, unvoiced hit on a random stop or fricative of the phrase */
function startPercussion() {
  if (!ready || pressed) return;
  const candidates = cells
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.cls === "stop" || c.cls === "affricate" || c.cls === "fricative");
  if (candidates.length === 0) return;
  const { c, i } = candidates[Math.floor(Math.random() * candidates.length)];
  const now = ctx.currentTime;
  restoreWhisper();
  targetPos = i + 0.5;
  voice.setWhisper(true, now);
  whisperRestoreAt = 0;
  transport.mode = "perc";
  transport.until = now + (c.cls === "fricative" ? rand(0.09, 0.2) : 0.07);
  explicitGate = null;
  openGate(true);
  paintTransport();
}

function tickTransport(now) {
  if (!transport.mode) return;

  if (transport.mode === "phoneme" || transport.mode === "perc") {
    if (now < transport.until) return;
    const wasPerc = transport.mode === "perc";
    transport.mode = null;
    openGate(false);
    // let the release stay unvoiced, then hand whisper back to the preset
    if (wasPerc) whisperRestoreAt = now + 0.3;
    paintTransport();
    return;
  }

  const dt = Math.max(0, Math.min(0.25, now - transport.last));
  transport.last = now;

  if (pronunciation === "word" && transport.mode === "scan") {
    const span = spanAt(targetPos);
    if (span > -1 && span !== lastSpanSeen) {
      lastSpanSeen = span;
      const before = targetPos;
      rerollSpan(span);
      if (targetPos !== before) transport.cellIndex = -1;
    }
  }

  const i = Math.max(0, Math.min(cells.length - 1, Math.floor(targetPos)));
  if (i !== transport.cellIndex) {
    transport.cellIndex = i;
    const [lo, hi] = RATES[transport.rate] || RATES.mid;
    const width = cells[i] ? cells[i].width : 1;
    transport.cellDur = Math.max(0.05, rand(lo, hi) * width);
  }
  targetPos += dt / transport.cellDur;

  const limit = transport.mode === "word" ? transport.stopAt : cells.length;
  if (targetPos >= limit) {
    targetPos = Math.max(0, Math.min(limit, cells.length) - 0.001);
    if (transport.mode === "scan") atEnd = true;
    transport.mode = null;
    transport.key = null;
    openGate(false);
    paintTransport();
  }
}

function paintTransport() {
  const el = $("transportState");
  if (!el) return;
  const label = transport.mode
    ? transport.mode === "scan" || transport.mode === "word"
      ? `${transport.mode} · ${transport.rate}`
      : transport.mode
    : "—";
  el.textContent = label;
  el.classList.toggle("on", !!transport.mode);
}

/* ================================================================ *
 *  vibrato
 * ================================================================ */

function applyVibrato() {
  if (!ready && !element) return;
  if (!element || !element.vibrato) return;
  const now = ctx.currentTime;
  element.vibrato.frequency.setTargetAtTime(vibrato.rate, now, 0.02);
  element.vibrato.gain.setTargetAtTime(vibrato.depth, now, 0.02);
  element.vibrato.wobble.setTargetAtTime(vibrato.wobble, now, 0.02);
}

/* ================================================================ *
 *  the little piano
 * ================================================================ */

const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const PIANO_LOW = 24; // C1 — the Bass part sits below C2
const PIANO_HIGH = 84; // C6
const BLACK = [1, 3, 6, 8, 10];

function noteName(midi) {
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** a name plus a cent offset, so a quarter-tone does not masquerade as a semitone */
function pitchLabel(midi) {
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  if (cents === 0) return noteName(nearest);
  return `${noteName(nearest)} ${cents > 0 ? "+" : "−"}${Math.abs(cents)}¢`;
}

function buildPiano() {
  const host = $("piano");
  if (!host) return;
  host.innerHTML = "";
  const whites = [];
  for (let m = PIANO_LOW; m <= PIANO_HIGH; m++) {
    if (!BLACK.includes(((m % 12) + 12) % 12)) whites.push(m);
  }
  const whiteWidth = 100 / whites.length;

  whites.forEach((m, index) => {
    const key = document.createElement("button");
    key.className = "pkey white";
    key.dataset.note = String(m);
    key.style.left = `${index * whiteWidth}%`;
    key.style.width = `${whiteWidth}%`;
    key.title = noteName(m);
    if (m % 12 === 0) {
      const tag = document.createElement("span");
      tag.textContent = noteName(m);
      key.appendChild(tag);
    }
    key.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      applyRemote("/scan/note", [m]);
    });
    host.appendChild(key);
  });

  for (let m = PIANO_LOW; m <= PIANO_HIGH; m++) {
    if (!BLACK.includes(((m % 12) + 12) % 12)) continue;
    const below = whites.filter((w) => w < m).length; // white keys to its left
    const key = document.createElement("button");
    key.className = "pkey black";
    key.dataset.note = String(m);
    key.style.left = `${below * whiteWidth - whiteWidth * 0.3}%`;
    key.style.width = `${whiteWidth * 0.6}%`;
    key.title = noteName(m);
    key.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      applyRemote("/scan/note", [m]);
    });
    host.appendChild(key);
  }
  paintPiano();
}

function paintPiano() {
  const host = $("piano");
  if (!host) return;
  const nearest = Math.round(note);
  const allowed = allowedNotes().map((n) => Math.round(n));
  host.querySelectorAll(".pkey").forEach((key) => {
    const m = Number(key.dataset.note);
    key.classList.toggle("on", m === nearest);
    key.classList.toggle("allowed", allowed.includes(m));
  });
  const label = $("pianoNote");
  if (label)
    label.textContent = `${pitchLabel(note)} · ${note.toFixed(2)} · ${(440 * Math.pow(2, (note - 69) / 12)).toFixed(1)} Hz`;
}

/* ================================================================ *
 *  presets, per phrase — for the composer, not the players
 * ================================================================ */

const PRESET_STORE = "tract.presets.v1";
let presets = {}; // phraseIndex -> preset
let presetWhisper = false;
let composerMode = false;

function capturePreset() {
  // store what is written, not what this part happens to sound.
  // Pitch is deliberately NOT stored: it belongs to the part's note list and
  // the player's choice on the keyboard, and a preset that dragged the pitch
  // around with it would fight both.
  const p = part();
  const out = {
    cfg: {},
    pronunciation,
    wordChoices: words.map((w) => w.choice),
    gain,
    wordMode,
    whisper: presetWhisper,
    vibrato: Object.assign({}, vibrato),
  };
  Object.keys(DEFAULTS).forEach((k) => (out.cfg[k] = cfg[k]));
  out.tractLength = (voice ? voice.tractLength : VOICE.tractLength) - (p.tractDelta || 0);
  return out;
}

/**
 * A preset holds the *written* settings; the part adds its body to them. What
 * the slider shows is always what you hear.
 *
 * Every phrase lands somewhere definite: its own preset if it has one, the
 * shipped defaults (DEFAULTS + VOICE) if it does not. Before, an unsaved phrase
 * simply kept whatever the previous phrase was doing, so saving a preset and
 * moving away and back changed nothing audible and the buttons looked dead.
 */
function applyPreset(index) {
  const preset = presets[index] || null;
  const p = part();
  wordMode = (preset && preset.wordMode) || "next";
  const sel = $("wordModeSel");
  if (sel) sel.value = wordMode;

  if (preset) {
    pronunciation = preset.pronunciation || "fixed";
    const modeSel = $("pronunciationSel");
    if (modeSel) modeSel.value = pronunciation;
    if (Array.isArray(preset.wordChoices)) {
      preset.wordChoices.forEach((choice, index) => {
        if (words[index] && choice < words[index].alts.length) words[index].choice = choice;
      });
    }
  }

  Object.keys(DEFAULTS).forEach((k) => {
    cfg[k] = preset && preset.cfg && k in preset.cfg ? preset.cfg[k] : DEFAULTS[k];
    syncControl(k, cfg[k]);
  });

  gain = preset && typeof preset.gain === "number" ? preset.gain : VOICE.gain;
  syncControl("gain", gain);
  if (master) master.gain.value = gain;

  Object.assign(vibrato, VOICE.vibrato, (preset && preset.vibrato) || {});
  syncControl("vibratoRate", vibrato.rate);
  syncControl("vibratoDepth", vibrato.depth);
  syncControl("wobble", vibrato.wobble);
  applyVibrato();

  // whisper is the exception: Z is a live performance control, so a phrase with
  // no preset of its own leaves it where the player put it
  if (preset) {
    presetWhisper = !!preset.whisper;
    syncControl("whisper", presetWhisper);
    if (ready) voice.setWhisper(presetWhisper, ctx.currentTime);
  }

  // pitch is the part's business, never the preset's: the note list for this
  // phrase decides what is available and the player picks from it
  const allowed = allowedNotes();
  if (allowed.length > 0 && !allowed.some((n) => Math.abs(n - note) < 0.01)) note = allowed[0];
  syncControl("note", note);
  paintPiano();
  paintNoteChoices();
  if (ready) voice.setNote(note, ctx.currentTime, 0);

  const writtenTract =
    preset && typeof preset.tractLength === "number" ? preset.tractLength : VOICE.tractLength;
  const tract = Math.max(15, Math.min(88, writtenTract + (p.tractDelta || 0)));
  syncControl("tractLength", tract);
  if (ready) voice.setTractLength(tract, ctx.currentTime);

  paintInstruction();
  paintPresetState();
}

/** says, at a glance, whether the phrase you are on carries a preset */
function paintPresetState() {
  const el = $("presetState");
  if (el) {
    const saved = !!presets[phraseIndex];
    const where = bridgeWrites ? "presets.json" : "this browser only";
    el.textContent =
      (saved ? `phrase ${phraseIndex + 1}: saved` : `phrase ${phraseIndex + 1}: defaults`) +
      ` · ${where}`;
    el.title = bridgeWrites
      ? "saving writes scan/presets.json in the repo"
      : "this page is not served by a bridge that can write, so saving stays in this browser";
    el.classList.toggle("saved", saved);
  }
  document.querySelectorAll("#phraseDots .dot").forEach((dot, i) => {
    dot.classList.toggle("has-preset", !!presets[i]);
  });
}

async function loadParts() {
  try {
    const response = await fetch("/scan/parts.json", { cache: "no-cache" });
    if (response.ok) {
      const data = await response.json();
      if (data && typeof data === "object") partsDoc = data;
      if (data && Array.isArray(data.parts) && data.parts.length) {
        parts = data.parts.map((p) => {
          if (!p.phrases && Array.isArray(p.instructions)) {
            p.phrases = p.instructions.map((instruction) => ({ instruction, notes: [] }));
          }
          return p;
        });
      }
    }
  } catch (e) {
    /* keep the fallback */
  }
  try {
    const saved = localStorage.getItem("tract.part");
    const found = parts.findIndex((p) => p.id === saved);
    if (found > -1) partIndex = found;
  } catch (e) {}

  const sel = $("partSel");
  if (sel) {
    sel.innerHTML = "";
    parts.forEach((p, i) => sel.appendChild(new Option(p.name, String(i))));
    sel.value = String(partIndex);
    sel.addEventListener("input", () => setPart(Number(sel.value)));
  }
  paintInstruction();
}

/** on opening the page a player must say which part they are on */
function openPartModal() {
  const modal = $("partModal");
  const list = $("partChoices");
  if (!modal || !list) return;
  list.innerHTML = "";
  parts.forEach((p, i) => {
    const button = document.createElement("button");
    button.className = "partchoice" + (i === partIndex ? " remembered" : "");
    // the name and nothing else: a player knows which part they are on, and
    // showing phrase 1's pitches here only invites choosing by ear
    button.textContent = p.name;
    button.addEventListener("click", async () => {
      setPart(i);
      modal.hidden = true;
      document.body.classList.remove("modal-open");
      await enableAudio(); // the click doubles as the gesture that starts audio
    });
    list.appendChild(button);
  });
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function setPart(index) {
  partIndex = Math.max(0, Math.min(parts.length - 1, index));
  try {
    localStorage.setItem("tract.part", parts[partIndex].id);
  } catch (e) {}
  const sel = $("partSel");
  if (sel) sel.value = String(partIndex);
  // a cue belongs to the part it was sent to, so changing part drops it; the
  // conductor's next heartbeat hands this part its own standing instruction
  cued.instruction = null;
  cued.cue = null;
  cued.oncoming = null;
  showOncoming(null);
  cueLight("idle", "—");
  applyPreset(phraseIndex); // re-reads the written settings through the new part
  sendOut("/scan/out/part", [partIndex + 1, parts[partIndex].name]);
  sayHello();
}

function paintInstruction() {
  const el = $("instruction");
  if (!el) return;
  // a cue the conductor has landed outranks the phrase's written instruction
  const text = cued.instruction !== null ? cued.instruction : partPhrase().instruction || "";
  el.textContent = text || "—";
  el.classList.toggle("empty", !text);
  const tag = $("partTag");
  if (tag) tag.textContent = part().name || "—";
  paintNoteChoices();
}

/* ================================================================ *
 *  the conductor's cues
 *
 *  The conductor page broadcasts one message per part it is speaking to.
 *  A player keeps only the messages addressed to its own part, so a cue that
 *  says nothing about you leaves your light dark and your instruction alone —
 *  which is the whole point: silence from the conductor is not a cue.
 * ================================================================ */

const cued = { instruction: null, cue: null, oncoming: null };
let goFlashTimer = null;

function cueLight(state, label) {
  const light = $("cueLight");
  const lamp = $("cueLamp");
  const text = $("cueLabel");
  if (!light) return;
  light.dataset.state = state;
  if (lamp) lamp.textContent = state === "count" ? label : "";
  if (text) text.textContent = state === "count" ? "count" : label;
}

function showOncoming(instruction) {
  const row = $("oncoming");
  const text = $("oncomingText");
  if (!row || !text) return;
  if (instruction === null) {
    row.hidden = true;
    text.textContent = "";
    return;
  }
  text.textContent = instruction;
  row.hidden = false;
}

/** is this cue message for me? */
function forMe(partId) {
  const mine = part().id;
  return String(partId) === String(mine);
}

function cuePrep(cue, partId, instruction) {
  if (!forMe(partId)) return;
  clearTimeout(goFlashTimer);
  cued.oncoming = instruction;
  cueLight("prep", `cue ${cue}`);
  showOncoming(instruction);
}

function cueCount(beat, partId) {
  if (partId !== undefined && partId !== null && !forMe(partId)) return;
  if (cued.oncoming === null) return; // not my cue: no counting either
  cueLight("count", String(beat));
}

function cueGo(cue, partId, instruction) {
  if (!forMe(partId)) return;
  cued.instruction = instruction;
  cued.cue = cue;
  cued.oncoming = null;
  showOncoming(null);
  paintInstruction();
  cueLight("go", `cue ${cue}`);
  clearTimeout(goFlashTimer);
  goFlashTimer = setTimeout(() => cueLight("idle", `cue ${cue}`), 900);
}

function cueClear(partId) {
  if (partId !== undefined && partId !== null && !forMe(partId)) return;
  cued.oncoming = null;
  showOncoming(null);
  cueLight("idle", cued.cue === null ? "—" : `cue ${cued.cue}`);
}

/**
 * The conductor repeats the standing cue every couple of seconds. A player who
 * reloads, joins late or switches part picks the instruction back up without a
 * flash — they missed the downbeat, they should not be given a fake one.
 */
function cueState(cue, partId, instruction) {
  if (!forMe(partId)) return;
  if (cued.instruction === instruction && cued.cue === cue) return;
  cued.instruction = instruction;
  cued.cue = cue;
  paintInstruction();
  if (!$("cueLight") || $("cueLight").dataset.state === "idle") cueLight("idle", `cue ${cue}`);
}

/** tell the conductor this part is here, so the roster lights up */
function sayHello() {
  const p = part();
  sendOut("/player/hello", [p.id, p.name, cued.cue === null ? -1 : Number(cued.cue) || 0]);
}
setInterval(() => {
  if (ws && ws.readyState === 1) sayHello();
}, 4000);

function saveInstruction(text) {
  const p = part();
  if (!p.phrases) p.phrases = [];
  if (!p.phrases[phraseIndex]) p.phrases[phraseIndex] = {};
  p.phrases[phraseIndex].instruction = text;
}

/** the chips beside the piano: this part's pitches for this phrase */
function paintNoteChoices() {
  const host = $("noteChoices");
  if (!host) return;
  const allowed = allowedNotes();
  host.innerHTML = "";
  if (allowed.length === 0) {
    const free = document.createElement("span");
    free.className = "note-free";
    free.textContent = "any pitch";
    host.appendChild(free);
    return;
  }
  allowed.forEach((n) => {
    const chip = document.createElement("button");
    chip.className = "note-chip" + (Math.abs(n - note) < 0.01 ? " on" : "");
    chip.textContent = pitchLabel(n);
    chip.title = `${n} · ${(440 * Math.pow(2, (n - 69) / 12)).toFixed(1)} Hz`;
    chip.addEventListener("click", () => applyRemote("/scan/note", [n]));
    host.appendChild(chip);
  });
}

/** does the thing serving this page accept writes? decides who owns the data */
let bridgeWrites = false;
async function probeBridge() {
  try {
    const response = await fetch("/bridge-info", { cache: "no-store" });
    if (response.ok) {
      const info = await response.json();
      bridgeWrites = !!(info && info.write === true);
    }
  } catch (e) {
    bridgeWrites = false;
  }
  return bridgeWrites;
}

async function loadPresets() {
  await probeBridge();
  // scan/presets.json is the document...
  try {
    const response = await fetch("/scan/presets.json", { cache: "no-cache" });
    if (response.ok) presets = await response.json();
  } catch (e) {
    /* none bundled */
  }
  // ...and when saving cannot reach the file — no bridge, or an older one —
  // this browser's copy is all there is, so it wins. With a writing bridge the
  // file always wins, which is what makes hand-editing presets.json work.
  if (!bridgeWrites) {
    try {
      const local = localStorage.getItem(PRESET_STORE);
      if (local) Object.assign(presets, JSON.parse(local));
    } catch (e) {}
  }
  applyPreset(phraseIndex);
}

function persistPresets() {
  try {
    localStorage.setItem(PRESET_STORE, JSON.stringify(presets));
  } catch (e) {}
}

function setupComposer() {
  if (SEARCH.get("composer") === "0") localStorage.removeItem("tract.composer");
  else if (SEARCH.has("composer")) {
    try {
      localStorage.setItem("tract.composer", "1");
    } catch (e) {}
  }
  try {
    composerMode = localStorage.getItem("tract.composer") === "1";
  } catch (e) {
    composerMode = SEARCH.has("composer") && SEARCH.get("composer") !== "0";
  }
  const maxPanel = $("maxPanel");
  if (maxPanel) maxPanel.hidden = !composerMode;
  const row = $("presetRow");
  if (!row) return;
  row.hidden = !composerMode;

  // The buttons are wired whether or not the row is showing. They used to be
  // wired only in composer mode, so anything that put the row on screen — a CSS
  // rule beating the hidden attribute, which is exactly what happened — left a
  // panel of controls that did nothing at all when clicked.
  $("presetSave").addEventListener("click", async () => {
    presets[phraseIndex] = capturePreset();
    persistPresets();
    paintPresetState();
    const wrote = await writeJSON("/scan/presets.json", presets, {
      fallback: "none",
      quiet: true,
    });
    if (wrote) flashPreset(`phrase ${phraseIndex + 1} → scan/presets.json`);
  });
  $("presetRevert").addEventListener("click", () => {
    applyPreset(phraseIndex);
    flashPreset(presets[phraseIndex] ? "back to the saved preset" : "back to the defaults");
  });
  $("presetClear").addEventListener("click", async () => {
    delete presets[phraseIndex];
    persistPresets();
    applyPreset(phraseIndex); // straight back to DEFAULTS + VOICE, audibly
    const wrote = await writeJSON("/scan/presets.json", presets, {
      fallback: "none",
      quiet: true,
    });
    if (wrote) flashPreset(`phrase ${phraseIndex + 1} cleared in scan/presets.json`);
  });
  $("wordModeSel").addEventListener("input", (event) => {
    wordMode = event.target.value;
  });
  const instruction = $("instruction");
  if (instruction && composerMode) {
    instruction.setAttribute("contenteditable", "true");
    instruction.classList.add("editable");
    instruction.addEventListener("input", () => saveInstruction(instruction.textContent.trim()));
    instruction.addEventListener("blur", async () => {
      saveInstruction(instruction.textContent.trim());
      const wrote = await writeJSON(
        "/scan/parts.json",
        Object.assign({}, partsDoc, { parts }),
        { fallback: "none", quiet: true }
      );
      if (wrote) flashPreset(`instruction for ${part().name} → scan/parts.json`);
    });
  }
  $("partsExport").addEventListener("click", () =>
    writeJSON("/scan/parts.json", Object.assign({}, partsDoc, { parts }))
  );
  $("presetExport").addEventListener("click", () => writeJSON("/scan/presets.json", presets));
  $("presetImport").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      presets = JSON.parse(await file.text());
      persistPresets();
      applyPreset(phraseIndex);
      flashPreset("imported");
    } catch (e) {
      flashPreset("could not read that file");
    }
    event.target.value = "";
  });
}

/**
 * Save straight into the repo. The bridge that serves this page accepts a PUT
 * for exactly these two files, so "write presets.json" writes
 * `scan/presets.json` where it belongs instead of dropping a copy in Downloads
 * for you to move by hand. Opened without the bridge — off a file:// path, or
 * from another machine — it falls back to the old download.
 */
/** JSON.stringify's indenting, but with short arrays kept on one line, so a
 *  hand-edited parts.json does not explode to one pitch per line. */
function prettyJSON(data) {
  return JSON.stringify(data, null, 2).replace(
    /\[\s*\n\s*((?:"[^"\n]*"|-?[\d.]+)(?:,\s*\n\s*(?:"[^"\n]*"|-?[\d.]+))*)\s*\n\s*\]/g,
    (whole, inner) => "[" + inner.replace(/\s*\n\s*/g, " ") + "]"
  );
}

async function writeJSON(url, data, { fallback = "download", quiet = false } = {}) {
  const text = prettyJSON(data);
  const name = url.split("/").pop();
  let why = "";
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: text,
    });
    let result = null;
    try {
      result = await response.json();
    } catch (e) {
      /* not our answer */
    }
    // An older bridge has no PUT handler at all: it ignores the method and
    // serves the file back, 200 and valid JSON. That looked exactly like a
    // successful write, which is why saving appeared to do nothing. Only the
    // acknowledgement the write handler sends counts.
    if (response.ok && result && result.ok === true) {
      if (!quiet) flashPreset(`wrote ${result.path || name}`);
      return true;
    }
    why = response.ok
      ? "the bridge is an older build — restart node scan-bridge/scan-bridge.js"
      : `the bridge refused it (${response.status})`;
  } catch (e) {
    why = "nothing is serving this page over HTTP";
  }

  if (fallback === "download") {
    const blob = new Blob([text], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
    flashPreset(`downloaded ${name}: ${why}`);
  } else {
    flashPreset(`saved in this browser only: ${why}`);
  }
  return false;
}

let flashTimer = null;
function flashPreset(message) {
  const el = $("presetStatus");
  if (!el) return;
  el.textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.textContent = ""), 2500);
}

/* ================================================================ *
 *  boot
 * ================================================================ */

/**
 * `scan.selftest()` in the console — saves a preset to this phrase, steps away,
 * comes back and checks that it returned, then puts the phrase back exactly as
 * it was. Answers "is saving broken, or is my browser running an old build?"
 * in one line.
 */
function selftest() {
  const where = phraseIndex;
  const had = presets[where] ? JSON.parse(JSON.stringify(presets[where])) : null;
  const canary = 0.0777;
  const lines = [`build ${BUILD}`, `composer ${composerMode}`, `bridge writes ${bridgeWrites}`];

  cfg.closeTime = canary;
  presets[where] = capturePreset();
  persistPresets();
  setPhrase((where + 1) % PHRASES.length, { announce: false });
  const away = cfg.closeTime;
  setPhrase(where, { announce: false });
  const back = cfg.closeTime;
  lines.push(`away ${away}`, `back ${back}`);
  lines.push(back === canary ? "RECALL OK" : "RECALL FAILED");

  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(PRESET_STORE) || "null");
  } catch (e) {}
  lines.push(
    stored && stored[where] && stored[where].cfg.closeTime === canary
      ? "localStorage OK"
      : "localStorage FAILED"
  );

  // put it back the way it was
  if (had) presets[where] = had;
  else delete presets[where];
  persistPresets();
  applyPreset(where); // the phrase goes back to whatever it really was

  const report = lines.join(" · ");
  console.log("Tract selftest: " + report);
  flashPreset(report);
  return report;
}

window.scan = {
  applyRemote,
  selftest,
  BUILD,
  cfg,
  startRecording,
  collectRecording,
  stopRecordingAndDownload,
  connectMIDI,
  get cells() {
    return cells;
  },
  get phrase() {
    return phraseIndex + 1;
  },
  get position() {
    return targetPos;
  },
  set position(p) {
    applyRemote("/scan/position", [p]);
  },
  get pressed() {
    return pressed;
  },
  isReady: () => ready,
  enableAudio,
  get transport() {
    return transport;
  },
  get wordSpans() {
    return wordSpans;
  },
  get vibrato() {
    return vibrato;
  },
  get presets() {
    return presets;
  },
  capturePreset,
  applyPreset,
  setPart,
  openPartModal,
  toggleWhisper,
  get presets() {
    return presets;
  },
  get whisper() {
    return presetWhisper;
  },
  get part() {
    return parts[partIndex];
  },
  get parts() {
    return parts;
  },
};

buildControls();
buildPiano();
setupComposer();
connectWS();
connectBroadcast();
connectMax();

$("startAudio").addEventListener("click", () => enableAudio());
$("record").addEventListener("click", () => {
  if (recorder) stopRecordingAndDownload();
  else if (!startRecording()) enableAudio();
});
$("prevPhrase").addEventListener("click", () => setPhrase(phraseIndex - 1));
$("nextPhrase").addEventListener("click", () => setPhrase(phraseIndex + 1));

function showTract(on) {
  if (!element) return;
  const host = $("tractHost");
  if (host.classList.contains("on") === on) return;
  toggleTract();
}

$("toggleTract").addEventListener("click", () => toggleTract());

function toggleTract() {
  if (!element) return;
  const host = $("tractHost");
  const showing = host.classList.toggle("on");
  if (showing) {
    element.enableUI();
    element.startUI();
    // the upstream UI lays out a 600x500 canvas plus glottis and button panels
    // inside a grid that does not reserve room for it, so it spills out of the
    // page. Keep the tract, drop the panels, and let the host clip.
    const ui = element.UI;
    if (ui && ui._container) {
      ui._container.style.gridTemplateRows = "auto";
      ui._container.style.gridTemplateColumns = "auto";
      if (ui._buttonsUI && ui._buttonsUI._container)
        ui._buttonsUI._container.style.display = "none";
      if (ui._glottisUI && ui._glottisUI._container)
        ui._glottisUI._container.style.display = "none";
    }
    $("toggleTract").textContent = "hide tract";
  } else {
    element.stopUI();
    $("toggleTract").textContent = "show tract";
  }
}

const HOLD_KEYS = { a: "slow", s: "mid", d: "fast" };
const SHOT_KEYS = { w: "slow", e: "mid", r: "fast" };

/** only somewhere you can type should swallow a keystroke */
function isTyping(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = (target.getAttribute("type") || "text").toLowerCase();
  return !["range", "checkbox", "radio", "button", "submit", "color", "file"].includes(type);
}

document.addEventListener("keydown", async (event) => {
  if (isTyping(event.target)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();

  if (key in HOLD_KEYS || key in SHOT_KEYS || key === "q" || key === "t" || key === "z") {
    event.preventDefault();
    if (event.repeat) return;
    if (!ctx) await enableAudio();
    if (key in HOLD_KEYS) startScan(HOLD_KEYS[key], key);
    else if (key in SHOT_KEYS) startWord(SHOT_KEYS[key]);
    else if (key === "q") startRandomPhoneme();
    else if (key === "t") startPercussion();
    else if (key === "z") toggleWhisper();
    return;
  }

  const stepSize = event.shiftKey ? 0.02 : 0.1;
  if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", " ", "Home"].includes(event.key)) {
    event.preventDefault(); // a focused slider should answer the mouse, not the keys
  }
  switch (event.key) {
    case "ArrowRight":
      applyRemote("/scan/position", [targetPos + stepSize]);
      break;
    case "ArrowLeft":
      applyRemote("/scan/position", [targetPos - stepSize]);
      break;
    case "ArrowDown":
    case "]":
      setPhrase(phraseIndex + 1);
      break;
    case "ArrowUp":
    case "[":
      setPhrase(phraseIndex - 1);
      break;
    case " ":
      event.preventDefault();
      applyRemote("/scan/gate", [voice && voice.gate > 0 ? 0 : 1]);
      break;
    case "Home":
      targetPos = 0;
      atEnd = false;
      break;
    default:
      if (/^[1-8]$/.test(event.key)) setPhrase(Number(event.key) - 1);
  }
});

document.addEventListener("keyup", (event) => {
  if (isTyping(event.target)) return;
  const key = event.key.toLowerCase();
  if (key in HOLD_KEYS) {
    event.preventDefault();
    stopScan(key);
  }
});
window.addEventListener("blur", () => stopScan());

// the dictionary loads itself over XHR; wait for it, then seed the strip
(function waitForDict(tries = 0) {
  if (dictReady() || tries > 200) {
    Promise.all([loadParts(), loadPresets()]).then(() => {
      setPhrase(0, { announce: false });
      const forced = SEARCH.get("part");
      if (forced !== null) {
        const index = parts.findIndex((p) => p.id === forced || p.name === forced);
        setPart(index > -1 ? index : Number(forced) - 1 || 0);
      } else {
        openPartModal();
      }
      console.log(
        `Tract build ${BUILD} · presets: ${Object.keys(presets).length} saved, ` +
          `saving writes ${bridgeWrites ? "scan/presets.json" : "this browser only"} · ` +
          `${composerMode ? "composer mode" : "player mode — open ?composer=1 for the preset row"}`
      );
    });
    return;
  }
  setTimeout(() => waitForDict(tries + 1), 100);
})();
