/*
  scan/src/scan.js — page glue: audio, strip UI, transports.
  The articulation logic lives in engine.js; the worklet repair in
  patched-pink-trombone.js.
*/

import { ScanVoice, buildTrack, DEFAULTS, OPEN, makeSilence } from "./engine.js";
import { loadPatchedPinkTrombone } from "./patched-pink-trombone.js";

/** bump alongside the ?v= in index.html; printed on load so there is never a
 *  question about which build a browser is actually running */
const BUILD = "2026-10-11a";

const $ = (id) => document.getElementById(id);
const strip = $("strip");
const cursor = $("cursor");
const ipaLine = $("ipaLine");
const altsHost = $("alts");
const readout = $("readout");
const controlsHost = $("controls");
const stripControlsHost = $("stripControls");

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
/* Seconds per phoneme while a scan key is held down. Slow is deliberately
 * glacial: A is a sweep the player ends by letting go, and three to five
 * seconds on one vowel is a held tone you steer, not a word. */
const RATES = {
  slow: [3, 5], // A
  mid: [0.25, 0.75], // S
  fast: [0.1, 0.25], // D — near speaking tempo
};

/* W, E and R are not held — one press plays one word and there is no way to
 * let go of it early. They therefore cannot use the hold rates: at three to
 * five seconds a phoneme, one tap on W is eight to ten seconds of unstoppable
 * drone, and cue 11 asks Part IV for "a steady pulse... a small gap between
 * presses", which that cannot be. Mid and fast are unchanged — the score is
 * written around them, and they measure right — so only slow comes down, to a
 * word you can pulse rather than a word you are stuck inside. */
const SHOT_RATES = {
  slow: [0.8, 1.6], // W — "CRACK" in 1.6 to 3.2 s
  mid: [0.25, 0.75], // E
  fast: [0.1, 0.25], // R
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
let sanitizer = null; // built once; every synth rebuild reconnects through it
// "worklet" or "main thread" — which audio path this laptop got. Worth seeing
// without opening a console, because the difference is invisible until it is
// not: on the main thread the synth competes with drawing, and the page only
// gets the worklet in a secure context (https, or localhost).
let audioPath = "?";
let voice = null;
let master = null;
let meterNode = null;
let meterBuffer = null;
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
let fadeNode = null; // the diminuendo stage, downstream of the fader
let fadeSeconds = 5; // the conductor sets this; 5 s until it says otherwise
let fading = false;
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

/**
 * A guard between the synth and everything downstream.
 *
 * Upstream Pink Trombone's worklet emits NaN for its first seven render quanta —
 * about 19 ms — every single time it starts. Measured here, and measured again
 * with `?nopatch=1`, so it is upstream's own doing and not one of this repo's
 * patches. NaN is not quiet: it is a click on the way out, it draws as a tract
 * that has flown apart, and if any of it ever settles into the delay line the
 * laptop is silent for the rest of the piece. A gain of zero does not help —
 * NaN times zero is still NaN — so it has to be replaced rather than turned
 * down. Non-finite samples become silence; anything past ±4 is clamped, which
 * no legitimate signal here ever reaches.
 *
 * Returns null if the worklet cannot be installed, and the caller then wires
 * the synth straight through: a guard that fails should not cost you the piece.
 */
const SANITIZER_SRC = `
class TractSanitize extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let c = 0; c < output.length; c++) {
      const src = input && input[c];
      const dst = output[c];
      if (!src) { dst.fill(0); continue; }
      for (let i = 0; i < dst.length; i++) {
        const v = src[i];
        // NaN fails both comparisons and falls through to 0
        dst[i] = v >= -4 && v <= 4 ? v : v > 4 ? 4 : v < -4 ? -4 : 0;
      }
    }
    return true;
  }
}
registerProcessor("tract-sanitize", TractSanitize);
`;

/**
 * The same clamp, on the main thread.
 *
 * AudioWorklet only exists in a secure context — https, or localhost. Served to
 * an ensemble over plain http on a LAN address it is simply absent, which is
 * also why upstream falls back to its own ScriptProcessorNode there. That is
 * exactly the case where the guard matters most: without it the worklet's
 * opening NaN goes straight to the speakers and into the tract view, and NaN in
 * the delay line never leaves. Deprecated and working beats modern and missing.
 */
function makeScriptSanitizer(context) {
  if (!context.createScriptProcessor) return null;
  // 512 frames, not the minimum: this runs on the main thread, and a laptop
  // drawing eight tracts has better things to do than service a 256-frame
  // callback.
  const node = context.createScriptProcessor(512, 2, 2);
  node.onaudioprocess = (event) => {
    const inBuf = event.inputBuffer;
    const outBuf = event.outputBuffer;
    for (let c = 0; c < outBuf.numberOfChannels; c++) {
      const dst = outBuf.getChannelData(c);
      const src = c < inBuf.numberOfChannels ? inBuf.getChannelData(c) : null;
      if (!src) {
        dst.fill(0);
        continue;
      }
      for (let i = 0; i < dst.length; i++) {
        const v = src[i];
        dst[i] = v >= -4 && v <= 4 ? v : v > 4 ? 4 : v < -4 ? -4 : 0;
      }
    }
  };
  return node;
}

async function makeSanitizer(context) {
  let url = null;
  try {
    // a way to exercise the fallback on a machine that does have AudioWorklet:
    // window.__forceScriptSanitizer = true before enabling audio
    if (window.__forceScriptSanitizer) throw new Error("forced to the fallback for testing");
    if (!context.audioWorklet) throw new Error("no AudioWorklet in this context");
    url = URL.createObjectURL(new Blob([SANITIZER_SRC], { type: "text/javascript" }));
    await context.audioWorklet.addModule(url);
    console.log("Tract: NaN guard installed (AudioWorklet).");
    audioPath = "worklet";
    paintBridgePill();
    return new AudioWorkletNode(context, "tract-sanitize");
  } catch (e) {
    const fallback = makeScriptSanitizer(context);
    if (fallback) {
      audioPath = "main thread";
      paintBridgePill();
      console.warn(
        "Tract: no AudioWorklet here, so the NaN guard is running as a " +
          "ScriptProcessorNode instead. That happens when the page is served over " +
          "plain http to anything but localhost \u2014 AudioWorklet needs a secure " +
          "context. Serve over https or localhost for the better path. (" +
          e.message +
          ")"
      );
      return fallback;
    }
    console.warn("scan: could not install the NaN guard, running without it \u2014", e.message);
    audioPath = "unguarded";
    paintBridgePill();
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

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

  // (see makeSanitizer, below). The synth node itself is built in buildSynth,
  // because standby builds a fresh one.
  sanitizer = await makeSanitizer(ctx);

  master = ctx.createGain();
  // Silent until the engine has been told to be silent. The upstream worklet
  // starts voicing its default vowel the moment it exists, and that is a good
  // fifty milliseconds before the lines below close the gate and zero the
  // intensity — which is the blurt players heard as the page came up.
  master.gain.value = 0;
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
  // the meter taps the very end of the chain: what leaves the page, after the
  // fader and after the safety net, not what the synth wishes it were sending
  meterNode = ctx.createAnalyser();
  meterNode.fftSize = 1024;
  meterNode.smoothingTimeConstant = 0;
  meterBuffer = new Float32Array(meterNode.fftSize);
  if (sanitizer) sanitizer.connect(master);
  // The diminuendo gets a stage of its own rather than driving the fader: a
  // player can still ride their own output while the fade is running, and the
  // fader is where they left it when it is over.
  fadeNode = ctx.createGain();
  fadeNode.gain.value = 1;
  master.connect(fadeNode);
  fadeNode.connect(limiter);
  limiter.connect(softClip);
  softClip.connect(meterNode);
  softClip.connect(ctx.destination);
  limiterNode = softClip;
  startMeter();
  await buildSynth();
}

/**
 * The synth node, and everything hanging off it.
 *
 * Separate from enableAudio because standby rebuilds it. NaN gets into the
 * tract's delay line during the worklet's first few render quanta and stays
 * there — the burst of noise, the tract view flying apart, and then a voice
 * that will not sound again. Nothing reachable from outside the processor
 * clears those arrays, so the cure is a new processor: drop this node, make
 * another, pose it before it runs.
 */
async function buildSynth() {
  element = document.createElement("pink-trombone");
  $("tractHost").appendChild(element);
  await element.setAudioContext(ctx);
  element.connect(sanitizer || master);

  // The synth is NOT started here. Upstream starts voicing the moment it runs,
  // on whatever geometry the tract happens to hold — and the two constrictions
  // below are claimed before the processor has acknowledged them, so for a few
  // blocks their index and diameter are undefined and the tract's own diameter
  // array goes NaN. NaN in the delay line is the blurt, and it is what makes the
  // tract view fly apart. Nothing runs until the pose below is in place.

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
  // and pose the tract now rather than on the first frame: between the worklet
  // starting and something telling it what shape to be, it is on its own
  // startup geometry, which is neither quiet nor a vocal tract
  if (cells[0] && cells[0].poses && cells[0].poses[0]) {
    voice.applyPose(cells[0].poses[0], ctx.currentTime, 0);
  }

  applyVibrato();

  // posed, quiet and in tune — now it may run, and only then does the output
  // fade in rather than switching on
  element.pinkTrombone.start();
  master.gain.setValueAtTime(0, ctx.currentTime);
  master.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.08);

  showTract(true);

  ready = true;
  $("startAudio").textContent = "audio running";
  $("startAudio").classList.remove("primary");
  window.scan.voice = voice;
  window.scan.ctx = ctx;
  window.scan.element = element;
}


/**
 * Standby, and a way back from a wedged engine.
 *
 * The worklet can come up with NaN in its tract arrays — a burst of noise, the
 * tract view flying apart, and then nothing at all, because NaN in a delay line
 * stays there forever. No parameter reaches inside the processor to clear it,
 * so the only cure is a new processor. Standby is the natural place to do it:
 * the piece is not sounding, everybody is waiting, and a player who has lost
 * their voice already knows to press {0}.
 *
 * It costs about a tenth of a second, and it is silent at both ends: the fader
 * is taken to zero before the old node goes and faded back up by buildSynth
 * once the new one is posed.
 */
let rebuilding = false;

async function resetEngine() {
  if (!ctx || rebuilding) return false;
  rebuilding = true;
  ready = false; // the frame loop must not drive a voice whose node is gone
  try {
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(0, ctx.currentTime);
    try {
      if (element.pinkTrombone && element.pinkTrombone.stop) element.pinkTrombone.stop();
    } catch (e) {
      /* it may already be stopped */
    }
    try {
      element.disconnect();
    } catch (e) {
      /* never connected */
    }
    // Park the old node rather than removing it on the spot: it answers its own
    // parameter requests over a port, and something may still be waiting. It
    // goes a couple of seconds later, by which time nothing is.
    //
    // A retired node still logs one upstream TypeError as it goes — its own
    // getProcessor reply dispatches at event.target, which the browser has
    // nulled by the time the promise resolves. Measured: about one per reset,
    // not one per frame, and nothing downstream of it is affected. Left
    // visible rather than swallowed, because a global error trap here would
    // hide the next real thing.
    const retired = element;
    retired.hidden = true;
    retired.style.display = "none";
    document.body.appendChild(retired);
    setTimeout(() => {
      try {
        retired.remove();
      } catch (e) {
        /* already gone */
      }
    }, 2000);
    await buildSynth(); // sets ready, and fades the output back in
    lastGesture = "engine reset";
    lastGestureAt = performance.now();
    return true;
  } catch (e) {
    console.warn("scan: could not rebuild the synth —", e && e.message);
    ready = true; // better a suspect engine than a dead page
    return false;
  } finally {
    rebuilding = false;
  }
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

/**
 * Phrase 0: the page is open and the piece has not started.
 *
 * It is a real phrase as far as everything else is concerned — you can be sent
 * to it, step off it, and come back — but it has no words, so the strip is empty
 * and there is nothing to sound. A player who opens the page early lands here
 * instead of sitting on "words strain" with a live strip under their hands.
 * Phrases 1–8 keep their numbers, so cues.json, presets.json and parts.json are
 * untouched by this.
 */
const STANDBY = -1;

/** stepping stops at standby rather than wrapping past it into phrase 8 */
function stepPhrase(by) {
  const next = phraseIndex + by;
  if (next < STANDBY) setPhrase(PHRASES.length - 1);
  else if (next >= PHRASES.length) setPhrase(STANDBY);
  else setPhrase(next);
}

function setPhrase(index, { announce = true, reset = true } = {}) {
  const count = PHRASES.length;
  const was = phraseIndex;
  // whatever was running belonged to the phrase we are leaving, including its
  // stop point — carrying it into the next one is never what anybody meant
  stopTransport();
  phraseIndex = index === STANDBY ? STANDBY : ((index % count) + count) % count;
  // Arriving at standby rebuilds the synth. It is the one moment in the piece
  // when silence is expected, so it is the one place a wedged engine can be
  // fixed without anybody hearing it happen.
  if (reset && phraseIndex === STANDBY && was !== STANDBY && ready) resetEngine();
  const phrase = phraseIndex === STANDBY ? "" : PHRASES[phraseIndex];

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

  $("phraseNum").textContent = phraseIndex === STANDBY ? `standby` : `${phraseIndex + 1}/${count}`;
  $("phraseText").textContent = phraseIndex === STANDBY ? "—" : phrase;
  paintDots();
  takeSeat(); // a new phrase is the only safe moment to re-seat the part
  sendPhraseState(); // the stage's subtitles follow the words, not a timer
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
  // phrase 0 first: a smaller dot, because it is a waiting room and not a phrase
  const standby = document.createElement("button");
  standby.className = "dot standby" + (phraseIndex === STANDBY ? " on" : "");
  standby.title = "0 — standby, before the piece starts";
  standby.setAttribute("aria-label", "standby");
  standby.addEventListener("click", () => setPhrase(STANDBY));
  host.appendChild(standby);
  PHRASES.forEach((phrase, i) => {
    const dot = document.createElement("button");
    dot.className = "dot" + (i === phraseIndex ? " on" : "");
    dot.title = `${i + 1} — ${phrase}`;
    dot.setAttribute("aria-label", phrase);
    dot.addEventListener("click", () => setPhrase(i));
    host.appendChild(dot);
  });
}

/**
 * The cell standby rests on: a schwa with the voice turned all the way off.
 *
 * A pose of nulls — which is what a plain silence cell is — means "leave the
 * tract as you found it", and at startup that is whatever geometry the worklet
 * came up in: not a mouth, and the shape that flew apart in the tract view. A
 * schwa is a real neutral vocal tract, so the drawing is a drawing and the
 * numbers going into the delay line are numbers. `a: 0` keeps it silent.
 */
function restCell() {
  const schwa = buildTrack("ə", phonemeTable(), cfg)[0];
  if (!schwa) return makeSilence(0);
  schwa.ipa = "·";
  schwa.stress = 0;
  schwa.poses = schwa.poses.map((p) => Object.assign({}, p, { a: 0, v: 0 }));
  return schwa;
}

function setTrack(ipa) {
  cells = buildTrack(ipa, phonemeTable(), cfg);
  // A track with nothing in it is not "silence" — it is the engine switched off.
  // `update()` returns at once with no cells, so the tract is never posed and
  // never told to be quiet: the worklet sits on its own startup geometry, which
  // draws as a burst of nonsense in the tract view and sounds like one too.
  // Standby therefore gets one rest cell, which is a real pose holding real
  // silence, applied every frame like any other.
  if (cells.length === 0) cells = [restCell()];
  computeCellStarts();
  computeWordSpans();
  renderStrip();
  wordsDirty = true; // the desk's miniatures are drawn from this
  if (voice) voice.setTrack(cells);
  targetPos = Math.min(targetPos, Math.max(0.001, cells.length - 0.001));
}

/* Cells are not all the same width — a pass-through stop is half an ordinary
 * phoneme and a held one is a little over. The strip lays them out by those
 * weights, so "half way along the strip" and "half way through the cells" are
 * two different places. This is the running total, which turns one into the
 * other; the conductor's miniature strips are drawn in the same space, so they
 * are true miniatures rather than approximate ones. */
let cellStarts = [];
let cellTotal = 1;

function computeCellStarts() {
  cellStarts = [];
  let run = 0;
  cells.forEach((cell) => {
    cellStarts.push(run);
    run += cell.width || 1;
  });
  cellTotal = run || 1;
}

/** where a playhead sits along the strip, 0 to 1 */
function posFraction(pos) {
  if (!cells.length) return 0;
  const i = Math.max(0, Math.min(cells.length - 1, Math.floor(pos)));
  const within = Math.max(0, Math.min(1, pos - i));
  return Math.max(0, Math.min(1, (cellStarts[i] + within * (cells[i].width || 1)) / cellTotal));
}

/**
 * The words, and where each one sits along the strip.
 *
 * The same grouping the strip itself draws — a run of cells sharing a word
 * index — measured in the same weighted space. The conductor gets this once
 * per phrase, not ten times a second: it only changes when the phrase does, or
 * when a pronunciation is re-rolled.
 */
function wordLayout() {
  const round = (n) => Math.round(n * 1000) / 1000;
  // every cell edge, so the desk's ticks fall where this player's actually do
  // rather than at even intervals that only look right
  const edges = cells.map((cell, i) => round((cellStarts[i] + (cell.width || 1)) / cellTotal));
  const out = [];
  let current = -2;
  cells.forEach((cell, i) => {
    const which = cell.cls === "silence" ? -1 : cell.wordIndex;
    if (which === -1) {
      current = -2;
      return;
    }
    if (which !== current) {
      out.push({ w: wordLabels[which] || "", a: round(cellStarts[i] / cellTotal), b: 0 });
      current = which;
    }
    out[out.length - 1].b = edges[i];
  });
  return { w: out, c: edges };
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

/** the long name for a cell's class — tooltip only, no longer printed on the tile */
function cellTag(cell) {
  switch (cell.cls) {
    case "stop":
      return cell.passThrough ? "stop" : "held stop";
    case "silence":
      return "gap";
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
      `${cell.ipa} — ${cellTag(cell)}` +
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
      `</span>`;
    // no class label under the glyph: the coloured bar already says vowel from
    // stop, and "APPR" under a letter is a linguistics lesson nobody asked for.
    // It survives in the tooltip.
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

function openGate(on, options) {
  if (!ready) return;
  if (on === voice.gate > 0) return;
  voice.setGate(on, ctx.currentTime, options);
}

/* ================================================================ *
 *  the spacebar, as a damper pedal
 *
 *  Hold it and whatever is sounding keeps sounding — the phoneme under the
 *  playbar, or the one Q or T just threw up. A one-shot the pedal catches stops
 *  counting down and waits for the pedal instead, so Q-then-space is a sustain
 *  rather than a stutter. Letting Q or T go under a held pedal does nothing.
 *  Letting the pedal go ends the note with the release envelope, and does NOT
 *  re-fire the key that is still held down: the next sound needs a new press,
 *  the way a piano key does.
 * ================================================================ */

let pedal = false;
let heldShot = null; // "q" or "t" while that key is down

/**
 * A held phoneme ends when nothing is holding it any more — neither the key
 * that started it nor the pedal. That is what lets Q-then-pedal work without a
 * gap in the middle: the note was never going to stop on its own.
 */
function endHeldShot() {
  if (transport.mode !== "phoneme" && transport.mode !== "perc") return;
  const now = ctx.currentTime;
  const wasPerc = transport.mode === "perc";
  transport.mode = null;
  if (wasPerc) whisperRestoreAt = now + Math.max(0.3, cfg.gateRelease || 0.3);
  if (voice.gate > 0) voice.setGate(false, now, { sustained: true });
  paintTransport();
}

/** the key came up: let go unless the pedal is still down */
function releaseShot(key) {
  if (heldShot !== key) return;
  heldShot = null;
  if (!ready || pedal) return;
  explicitGate = null;
  endHeldShot();
}

async function pressPedal() {
  if (pedal) return;
  pedal = true;
  if (!ctx) await enableAudio();
  if (!ready) return;
  explicitGate = 1;
  openGate(true);
  paintTransport();
}

function liftPedal() {
  if (!pedal) return;
  pedal = false;
  explicitGate = null;
  if (!ready) return;
  // a Q or T still under a finger goes on sounding; the pedal was only the
  // second thing holding it
  if (heldShot) return;
  if (transport.mode === "phoneme" || transport.mode === "perc") {
    endHeldShot();
    return;
  }
  if (voice.gate > 0) voice.setGate(false, ctx.currentTime, { sustained: true });
  paintTransport();
}

/* ================================================================ *
 *  frame loop
 * ================================================================ */

let paintedCell = -1;
let paintedClosed = false;

function frame() {
  requestAnimationFrame(frame);
  if (seatsDirty && seatsCanSettle()) takeSeat();
  if (!ready) return;

  const now = ctx.currentTime;
  tickTransport(now);
  if (whisperRestoreAt && now >= whisperRestoreAt) {
    whisperRestoreAt = 0;
    voice.setWhisper(whisperOn, now);
    syncControl("whisper", whisperOn);
  }
  voice.update(targetPos, now);

  const stripRect = strip.getBoundingClientRect();
  cursor.style.opacity = voice.gate > 0 ? "1" : "0.28";
  cursor.style.left = `${xFromPos(targetPos) - stripRect.left}px`;

  if (fading) paintFade();

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
      // Nothing here touches the pitch. A drifting phrase is a band the
      // player moves inside by hand; the page never draws for them.
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
      stepPhrase(1);
      break;
    case "/scan/prev":
      stepPhrase(-1);
      break;
    case "/scan/note":
      note = num(a0, note);
      rememberChoice();
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
        if (REBUILD_KEYS.has(a0)) setTrack(currentIpa);
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
    case "/cue/fade": // how long the diminuendo at the end should take
      fadeSeconds = Math.max(0.2, Math.min(300, num(a0, fadeSeconds)));
      paintFadeLength();
      break;
    case "/cue/next": // what is coming, sent the moment the last downbeat landed
      cueNext(a0, args[1], String(args[2] ?? ""));
      break;
    case "/cue/ping": // a conductor is at the desk: say who is here, and feed it
      deskSeenAt = performance.now();
      sayHello();
      break;
    case "/stage/hello": // the projection page is up; start feeding it
      stageSeenAt = performance.now();
      break;
    case "/player/hello": // another player on the network; seats are built from these
      heardPeer(a0, args[3]);
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
    connected = true;
    paintBridgePill();
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
  { key: "sibilantLevel", label: "sibilant level", min: 0.85, max: 1, step: 0.005, unit: "" },
  { key: "gateRelease", label: "release", min: 0.01, max: 3, step: 0.01, unit: "s" },
  { key: "stressSemitones", label: "stressed-vowel lift", min: 0, max: 2, step: 0.05, unit: "" },
  // up to two seconds, so a drifting phrase can really slide between pitches
  { key: "glide", label: "pitch glide", min: 0, max: 2, step: 0.01, unit: "s" },
  { key: "note", label: "pitch (MIDI note)", min: 24, max: 84, step: 0.01, unit: "", special: true },
  { key: "tractLength", label: "tract length", min: 15, max: 88, step: 1, unit: "", special: true },
  // output level lives in the bar at the top of the page now, beside the meter
  { key: "vibratoRate", label: "vibrato rate", min: 0.1, max: 12, step: 0.1, unit: "", special: true },
  { key: "vibratoDepth", label: "vibrato depth", min: 0, max: 0.04, step: 0.001, unit: "", special: true },
  // host "strip": lives under the phoneme strip, within reach mid-rehearsal.
  // Still a CONTROLS entry, so it still saves and loads with the preset.
  { key: "wobble", label: "pitch drift (wobble)", min: 0, max: 1, step: 0.01, unit: "", special: true, host: "strip" },
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
  "stressSemitones":
    "How far the pitch lifts on a stressed vowel, in semitones \u2014 the thing English speech does and singing a written pitch does not. 0 means the piano is exact: every phoneme sounds the key you pressed. Turn it up for speech.",
  "sibilantLevel":
    "How loud s, sh and their unvoiced relatives are next to everything else. NOT a fader — the " +
    "synthesis drives frication nonlinearly, so 0.85 is already far down and 1 is untrimmed. " +
    "0.93 measured level with the voiced phonemes of \"words strain\".",
  "gateRelease":
    "How long a sustained phoneme takes to die away when you let go of the spacebar — a " +
    "diminuendo instead of a cut. Does not affect the stops, which keep their own timing.",
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
    const home = spec.host === "strip" && stripControlsHost ? stripControlsHost : controlsHost;
    home.appendChild(wrap);
  });
  paintWhisperTag(whisperOn); // nothing has synced it yet on a fresh page
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
    if (REBUILD_KEYS.has(spec.key)) setTrack(currentIpa);
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
      whisperOn = !!value;
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

/**
 * The whisper light under the strip.
 *
 * Z is latching and nothing else touches it any more, so a player can carry a
 * whisper across a phrase change without noticing. This says which it is,
 * where they are already looking.
 */
/**
 * The pill in the header: who we are talking to, and which audio path this
 * laptop ended up on.
 *
 * "worklet" is the good one — the synth runs off the main thread. "main thread"
 * means the page was not served from a secure context, so there is no
 * AudioWorklet here and everything is sharing a thread with the drawing. It is
 * on the pill rather than in a console because checking sixteen laptops at a
 * soundcheck should be a walk past them, not sixteen consoles.
 */
let connected = false;

function paintBridgePill() {
  const pill = $("wsStatus");
  if (!pill) return;
  const port = location.port || (location.protocol === "https:" ? 443 : 80);
  const where = connected ? `bridge: ${location.hostname}:${port}` : "bridge: —";
  pill.textContent = audioPath === "?" ? where : `${where} · ${audioPath}`;
  pill.className = "pill" + (connected ? " on" : "") + (audioPath === "worklet" || audioPath === "?" ? "" : " warn");
  pill.title =
    audioPath === "worklet"
      ? "AudioWorklet: the synth runs off the main thread. This is the good path."
      : audioPath === "main thread"
        ? "No AudioWorklet here, so the synth is sharing the main thread with the drawing. " +
          "That happens when the page is served over plain http to anything but localhost — " +
          "serve it over https instead."
        : audioPath === "unguarded"
          ? "No NaN guard at all on this laptop. Reload; if it persists, something is wrong."
          : "which bridge this page is talking to";
}

function paintWhisperTag(on) {
  const el = $("whisperTag");
  if (!el) return;
  el.dataset.on = on ? "1" : "0";
  const word = el.querySelector(".state");
  if (word) word.textContent = on ? "on" : "off";
}

function syncControl(key, value) {
  // the fader at the top of the page is the same number as the one in
  // *timing & voice*, wherever the change came from — a preset, the conductor,
  // OSC, or either slider
  if (key === "gain") {
    const slider = $("masterGain");
    const out = $("masterGainOut");
    if (slider && document.activeElement !== slider) slider.value = String(value);
    if (out) out.textContent = Number(value).toFixed(2);
  }
  if (key === "whisper") paintWhisperTag(!!value);
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
  if (ready && voice.whisper !== whisperOn) {
    voice.setWhisper(whisperOn, ctx.currentTime);
    syncControl("whisper", whisperOn);
  }
}

/** Z: breath instead of voice, and back. Latching, so it survives T and Q. */
function toggleWhisper() {
  whisperRestoreAt = 0; // whatever the percussion key was going to hand back
  whisperOn = !whisperOn;
  syncControl("whisper", whisperOn);
  applyRemote("/scan/whisper", [whisperOn ? 1 : 0]);
  lastGesture = whisperOn ? "whisper on" : "whisper off";
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
  // under a held pedal, letting a scan key go leaves the phoneme sounding where
  // it stopped — which is the whole point of a pedal
  if (pedal) {
    explicitGate = 1;
    openGate(true);
  } else {
    openGate(false);
  }
  paintTransport();
}

/**
 * Drop whatever the transport is doing and go quiet.
 *
 * A one-shot word had no way out: pressing the key again restarts it (which
 * cue 10 asks for), and nothing else touched it — so a player who started a
 * word at the wrong moment had to wait it out. This is the way out, and it is
 * also what a phrase change does, because a word left running crawls on
 * through the next phrase against a stop point that belonged to the last one.
 *
 * It ignores the pedal on purpose. "Stop" has to mean stop.
 */
function stopTransport() {
  if (!transport.mode) return;
  const wasPerc = transport.mode === "perc";
  transport.mode = null;
  transport.key = null;
  heldShot = null;
  explicitGate = null;
  openGate(false);
  if (wasPerc && ctx) whisperRestoreAt = ctx.currentTime + 0.3;
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
    .filter(({ c }) => c.cls !== "silence" && c.voiced);
  if (candidates.length === 0) return;
  const { i } = candidates[Math.floor(Math.random() * candidates.length)];
  targetPos = i + 0.5;
  transport.mode = "phoneme";
  transport.until = Infinity; // held: it ends when the key comes up
  explicitGate = null;
  openGate(true);
  paintTransport();
}

/** a percussive, unvoiced hit on a random stop or fricative of the phrase */
function startPercussion() {
  if (!ready || pressed) return;
  const candidates = cells
    .map((c, i) => ({ c, i }))
    .filter(
      ({ c }) =>
        c.cls !== "silence" &&
        (c.cls === "stop" || c.cls === "affricate" || c.cls === "fricative" || !c.voiced)
    );
  if (candidates.length === 0) return;
  const { c, i } = candidates[Math.floor(Math.random() * candidates.length)];
  const now = ctx.currentTime;
  restoreWhisper();
  targetPos = i + 0.5;
  voice.setWhisper(true, now);
  whisperRestoreAt = 0;
  transport.mode = "perc";
  transport.until = Infinity; // held, like Q
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
    const table = transport.mode === "word" ? SHOT_RATES : RATES;
    const [lo, hi] = table[transport.rate] || table.mid;
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
 *  the diminuendo
 *
 *  The end of the piece is everyone fading to nothing together. It is one key —
 *  ↓, which is hard to hit by accident and impossible to hit while your hands
 *  are on A–D — and the conductor sets how long it takes, in seconds, so the
 *  whole ensemble decays at the same rate rather than at four guesses.
 *
 *  It rides its own gain stage, so the player's own fader still works during
 *  the fade and is untouched afterwards. The curve is a shaped one, not a
 *  straight line: a linear amplitude ramp is heard as sitting at full volume
 *  and then dropping off a cliff at the end.
 * ================================================================ */

function fadeCurve(points = 128) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    curve[i] = Math.pow(1 - t, 2.2); // steady to the ear, silent at the end
  }
  curve[points - 1] = 0;
  return curve;
}

/** a value curve cannot be interrupted by an ordinary event, so clear it first —
 *  cancelAndHoldAtTime where it exists, and never let either throw */
function releaseFadeAutomation(now) {
  const g = fadeNode.gain;
  try {
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now);
    else g.cancelScheduledValues(now);
  } catch (e) {
    try {
      g.cancelScheduledValues(now);
    } catch (e2) {
      /* nothing scheduled */
    }
  }
}

function startFade() {
  if (!ready || !fadeNode) return;
  const now = ctx.currentTime;
  const seconds = Math.max(0.2, Math.min(300, fadeSeconds));
  releaseFadeAutomation(now);
  fadeNode.gain.setValueAtTime(fadeNode.gain.value, now);
  fadeNode.gain.setValueCurveAtTime(fadeCurve(), now, seconds);
  fading = true;
  fadeEndsAt = now + seconds;
  paintFade();
  sendOut("/scan/out/fade", [seconds]);
}

/** ↑ — for the rehearsal where someone hits ↓ in the middle of phrase three */
function cancelFade() {
  if (!ready || !fadeNode || !fading) return;
  const now = ctx.currentTime;
  releaseFadeAutomation(now);
  fadeNode.gain.setValueAtTime(fadeNode.gain.value, now);
  fadeNode.gain.linearRampToValueAtTime(1, now + 0.4);
  fading = false;
  fadeEndsAt = 0;
  paintFade();
}

/** the length the conductor has set, shown where the player can see it */
function paintFadeLength() {
  const el = $("fadeLen");
  if (el) el.textContent = `${Number(fadeSeconds.toFixed(1))} s`;
}

let fadeEndsAt = 0;
function paintFade() {
  const el = $("fadeTag");
  if (!el) return;
  if (!fading) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  const left = Math.max(0, fadeEndsAt - (ctx ? ctx.currentTime : 0));
  el.textContent = left > 0.05 ? `diminuendo · ${left.toFixed(1)} s` : "silent";
}

/* ================================================================ *
 *  the little piano
 * ================================================================ */

const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const PIANO_LOW = 24; // C1 — the Bass part sits below C2
const PIANO_HIGH = 72; // C5 — nothing in the piece is written above it
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
    // every white key carries its name; only the Cs show theirs unless the
    // player asks for all of them (see the "note names" toggle)
    const tag = document.createElement("span");
    tag.className = m % 12 === 0 ? "octave" : "name";
    tag.textContent = noteName(m);
    key.appendChild(tag);
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
    const blackTag = document.createElement("span");
    blackTag.className = "name";
    blackTag.textContent = noteName(m);
    key.appendChild(blackTag);
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
  // a drifting phrase lights its whole band, so the keys you may click are the
  // keys that look clickable
  const band = pitchMode() === "drift" ? pitchRange() : null;
  host.querySelectorAll(".pkey").forEach((key) => {
    const m = Number(key.dataset.note);
    key.classList.toggle("on", m === nearest);
    key.classList.toggle(
      "allowed",
      band ? m >= band.low - 0.01 && m <= band.high + 0.01 : allowed.includes(m)
    );
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
let whisperOn = false;
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
    // whisper is deliberately NOT here. It is the players' to turn on and off
    // with Z, cue by cue; a preset that carried it would reach across a phrase
    // change and undo them.
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

  // whisper is not a preset property at all: changing phrase leaves it exactly
  // where the player put it, which is what the cue sheet assumes

  // Pitch is the part's business, never the preset's. How much of it is the
  // player's business is written into the phrase: fixed, assign, choose, drift.
  const chosen = pitchForPhrase();
  if (chosen !== null && isFinite(chosen)) note = chosen;
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

/* ================================================================ *
 *  the player's name
 *
 *  Only the conductor ever sees it: it goes out on the hello and sits above
 *  this laptop's strip on the desk. It is kept in localStorage, which is a
 *  per-browser, per-origin box that survives the tab being closed — so a
 *  player types it the first time they open the page on that laptop and never
 *  again. Two caveats worth knowing:
 *
 *    - "per-origin" means scheme + host + port. The room's address is the
 *      origin, so if the bridge comes up on a different IP tomorrow the name
 *      is typed once more. Nothing is lost; it is just a different box.
 *    - a private window has its own box, thrown away on close.
 *
 *  Not a cookie: a cookie would be attached to every request the browser makes
 *  to the bridge, which is traffic this piece has no use for. localStorage
 *  stays in the browser until the page asks for it.
 * ================================================================ */

const NAME_STORE = "tract.name";
let playerName = "";

function tidyName(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

function loadName() {
  try {
    playerName = tidyName(localStorage.getItem(NAME_STORE));
  } catch (e) {
    playerName = ""; // storage disabled: the piece runs, the desk shows the part
  }
  paintNameChip();
}

function setName(text) {
  const clean = tidyName(text);
  if (clean === playerName) return;
  playerName = clean;
  try {
    if (clean) localStorage.setItem(NAME_STORE, clean);
    else localStorage.removeItem(NAME_STORE);
  } catch (e) {}
  paintNameChip();
  sayHello(); // the desk relabels the strip without waiting for the heartbeat
}

function paintNameChip() {
  const chip = $("nameChip");
  if (!chip) return;
  chip.textContent = playerName || "name?";
  chip.classList.toggle("unset", !playerName);
}

/** the chip becomes a text field only while it is being edited */
function wireNameChip() {
  const chip = $("nameChip");
  const edit = $("nameEdit");
  if (!chip || !edit) return;
  const close = (keep) => {
    if (keep) setName(edit.value);
    edit.hidden = true;
    chip.hidden = false;
  };
  chip.addEventListener("click", () => {
    edit.value = playerName;
    chip.hidden = true;
    edit.hidden = false;
    edit.focus();
    edit.select();
  });
  edit.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      edit.blur(); // the blur does the saving, so both paths agree
    } else if (event.key === "Escape") {
      event.preventDefault();
      edit.value = playerName;
      edit.blur();
    }
    event.stopPropagation(); // A, S, D and the rest are text here, not transport
  });
  edit.addEventListener("blur", () => close(true));
}

/** on opening the page a player must say which part they are on */
function openPartModal() {
  const modal = $("partModal");
  const list = $("partChoices");
  const nameField = $("nameInput");
  if (!modal || !list) return;
  if (nameField) nameField.value = playerName;
  list.innerHTML = "";
  parts.forEach((p, i) => {
    const button = document.createElement("button");
    button.className = "partchoice" + (i === partIndex ? " remembered" : "");
    // the name and nothing else: a player knows which part they are on, and
    // showing phrase 1's pitches here only invites choosing by ear
    button.textContent = p.name;
    button.addEventListener("click", async () => {
      if (nameField) setName(nameField.value); // before the part, so one hello carries both
      setPart(i);
      modal.hidden = true;
      document.body.classList.remove("modal-open");
      await enableAudio(); // the click doubles as the gesture that starts audio
    });
    list.appendChild(button);
  });
  modal.hidden = false;
  document.body.classList.add("modal-open");
  // the name is the only thing here you type, so put the caret in it — but not
  // on a phone, where focusing a field throws a keyboard over the part buttons
  if (nameField && !playerName && !matchMedia("(pointer: coarse)").matches) nameField.focus();
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
  cued.armed = false;
  showOncoming(null);
  cueLight("idle", "—");
  applyPreset(phraseIndex); // re-reads the written settings through the new part
  sendOut("/scan/out/part", [partIndex + 1, parts[partIndex].name]);
  // say so at once rather than waiting for the next heartbeat: the conductor's
  // roster and the bridge's log both name a player by the part it is on, and
  // the first hello goes out before ?part= or the modal has been answered
  sayHello();
  sayHello();
}

/**
 * What a player reads before the conductor has said anything. Every phrase
 * shows this, however they got there — stepping through the phrases on their own
 * does not hand them an instruction nobody gave them.
 */
const WAITING =
  "Waiting for cues. Make sure your audio output is up and you are connected to the conductor.";

/**
 * Key names in an instruction can be written in curly brackets — "Hold {A} to
 * scan slowly", "{↑ ↓} to step" — and come out as the same little key boxes as
 * the legend. Everything outside the brackets is escaped first, so a cue file is
 * text, never markup.
 */
function escapeAndKeys(text) {
  const escaped = String(text).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
  const withKeys = escaped.replace(/\{([^{}]{1,12})\}/g, (whole, key) => {
    const label = key.trim();
    if (!label) return whole;
    return `<span class="keycap${label.length > 2 ? " wide" : ""}">${label}</span>`;
  });
  // Pitches are written <A4>, <Bb2>, <51.5>. The angle brackets have already
  // become &lt; and &gt; by now, which is what makes this safe: a stray "<" in
  // an instruction can never open a tag, so this only ever matches what the cue
  // file actually wrote.
  return withKeys.replace(/&lt;([^&]{1,12}?)&gt;/g, (whole, pitch) => {
    const label = pitch.trim();
    if (!label) return whole;
    return `<span class="pitchcap">${label}</span>`;
  });
}

/**
 * One sentence per line. An instruction is a list of things to do in order, and
 * reading it off a screen mid-performance is easier when they are stacked than
 * when they run together as a paragraph.
 *
 * The split needs whitespace after the full stop, so "0.25 s" and "Bb2." stay
 * whole, and it takes a closing quote or bracket with it — `break.'` ends a
 * line. Sentences are split on the raw text and escaped afterwards, so the
 * split can never land in the middle of a tag.
 */
function sentences(text) {
  return String(text)
    .split(/(?<=[.!?]["'”’)\]]?)\s+(?=\S)/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function instructionHTML(text) {
  const lines = sentences(text);
  if (lines.length < 2) return escapeAndKeys(text);
  return lines.map((line) => `<span class="sentence">${escapeAndKeys(line)}</span>`).join("");
}

function paintInstruction() {
  const el = $("instruction");
  if (!el) return;
  // a cue the conductor has landed outranks everything; with no cue a player
  // sees the waiting line, except in composer mode where the phrase's own
  // instruction is what you are editing
  let text = WAITING;
  if (cued.instruction !== null) text = cued.instruction;
  else if (composerMode && partPhrase().instruction) text = partPhrase().instruction;
  // In composer mode the line is contenteditable and what you type is what gets
  // written to parts.json, so it stays plain text — sentence spans would come
  // back out of textContent with the spaces between sentences eaten.
  if (composerMode && cued.instruction === null) el.textContent = text;
  else el.innerHTML = instructionHTML(text);
  el.classList.toggle("waiting", cued.instruction === null && text === WAITING);
  fitInstruction();
  paintNoteChoices();
}

/**
 * A sentence per line means a long cue is tall, and the page has promised not
 * to scroll. So the type gives way: start from whatever the stylesheet asks for
 * and step down a pixel at a time until the page fits, never below 16px — which
 * is the floor, not a suggestion. Past that it can scroll; legibility wins.
 */
const MIN_INSTRUCTION_PX = 16;
function fitInstruction() {
  const el = $("instruction");
  if (!el) return;
  el.style.fontSize = ""; // back to whatever the stylesheet asks for
  const doc = document.documentElement;
  let size = parseFloat(getComputedStyle(el).fontSize);
  if (!isFinite(size)) return;
  // the test is simply whether the page overflows — asking for a little slack
  // instead made it shrink a step even when everything already fitted
  while (size > MIN_INSTRUCTION_PX && doc.scrollHeight > window.innerHeight) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}
let fitTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitInstruction, 120);
});
// the tract panel opens and closes on a transition, so the page is a different
// height a moment later — measure again when it has finished moving
const tractHost = $("tractHost");
if (tractHost) tractHost.addEventListener("transitionend", fitInstruction);

/* ================================================================ *
 *  the conductor's cues
 *
 *  The conductor page broadcasts one message per part it is speaking to.
 *  A player keeps only the messages addressed to its own part, so a cue that
 *  says nothing about you leaves your light dark and your instruction alone —
 *  which is the whole point: silence from the conductor is not a cue.
 * ================================================================ */

/* `oncoming` is what is written up next; `armed` is whether the conductor has
 * put a hand up for it. They used to be the same thing — the text appeared
 * with the amber light — but a player reading two lines of new instruction in
 * the four seconds before a downbeat is a player who is not listening. The
 * text now arrives as soon as the previous downbeat lands, and the light means
 * only "soon". */
const cued = { instruction: null, cue: null, oncoming: null, armed: false };
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
  if (instruction === null || instruction === "") {
    row.hidden = true;
    row.dataset.armed = "0";
    text.textContent = "";
    return;
  }
  text.innerHTML = instructionHTML(instruction);
  row.hidden = false;
  row.dataset.armed = cued.armed ? "1" : "0";
}

/** is this cue message for me? */
function forMe(partId) {
  const mine = part().id;
  return String(partId) === String(mine);
}

/**
 * What is written up next, with no light: sent as soon as the previous
 * downbeat lands, and repeated on the desk's heartbeat so a late arrival
 * catches it too. An empty instruction means the next cue says nothing to
 * this part, and the line goes away.
 */
function cueNext(cue, partId, instruction) {
  if (!forMe(partId)) return;
  if (cued.armed) return; // a hand is already up: do not move the text under it
  const text = instruction === "" ? null : instruction;
  if (cued.oncoming === text) return;
  cued.oncoming = text;
  showOncoming(text);
}

function cuePrep(cue, partId, instruction) {
  if (!forMe(partId)) return;
  clearTimeout(goFlashTimer);
  cued.armed = true;
  cued.oncoming = instruction;
  cueLight("prep", `cue ${cue}`);
  showOncoming(instruction);
}

function cueCount(beat, partId) {
  if (partId !== undefined && partId !== null && !forMe(partId)) return;
  if (!cued.armed) return; // not my cue: no counting either
  cueLight("count", String(beat));
}

function cueGo(cue, partId, instruction) {
  if (!forMe(partId)) return;
  cued.instruction = instruction;
  cued.cue = cue;
  cued.armed = false;
  // and the line below clears — the desk sends the next one along behind this
  cued.oncoming = null;
  showOncoming(null);
  paintInstruction();
  cueLight("go", `cue ${cue}`);
  clearTimeout(goFlashTimer);
  goFlashTimer = setTimeout(() => cueLight("idle", `cue ${cue}`), 900);
}

function cueClear(partId) {
  if (partId !== undefined && partId !== null && !forMe(partId)) return;
  // the hand comes down, but what is coming stays legible
  cued.armed = false;
  showOncoming(cued.oncoming);
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



/* ================================================================ *
 *  seats, and how a part's pitches get shared out
 *
 *  Three or four players on a part, two or three pitches written for it: who
 *  sings which? The players work it out among themselves. Everyone already
 *  hears everyone else's `/player/hello`, so each page sorts the machine ids it
 *  has heard for its own part and takes its own index — every page computes the
 *  same list, so every page agrees, with no conductor in the loop and nothing
 *  to set up. `?seat=2` overrides it for a rehearsal.
 *
 *  Seats are only re-taken at a phrase change. Somebody joining or dropping out
 *  mid-phrase would otherwise move a pitch under a player who is holding it.
 * ================================================================ */

const SEAT_OVERRIDE = Number(SEARCH.get("seat")) || 0;
const peers = new Map(); // machine -> { part, at }
let seat = 1; // 1-based, within this part
let seatsOf = 1; // how many of us are on this part
let seatsDirty = false; // the roster moved; re-seat as soon as it is safe to

function heardPeer(partId, machine) {
  if (!machine) return;
  const known = peers.get(String(machine));
  peers.set(String(machine), { part: String(partId), at: performance.now() });
  // Somebody new on our part changes the arithmetic. Seats cannot move under a
  // player who is singing, but two players who open the page together and never
  // change phrase would otherwise both sit in seat 1 and both take the first
  // written pitch — the one case the whole scheme exists to prevent. So the
  // roster is marked dirty and settles at the next quiet moment.
  if (!known || known.part !== String(partId)) seatsDirty = true;
}

/** a moment when re-seating cannot pull a pitch out from under anyone */
function seatsCanSettle() {
  return !pressed && !transport.mode && (!ready || voice.gate === 0);
}

/** the machines on this part, most recent nine seconds, in a stable order */
function seatRoster() {
  const mine = String(part().id);
  const now = performance.now();
  const ids = [MACHINE];
  peers.forEach((info, machine) => {
    if (info.part === mine && machine !== MACHINE && now - info.at < 9000) ids.push(machine);
  });
  return ids.sort();
}

function takeSeat() {
  seatsDirty = false;
  const roster = seatRoster();
  seatsOf = roster.length;
  seat = SEAT_OVERRIDE > 0 ? SEAT_OVERRIDE : roster.indexOf(MACHINE) + 1 || 1;
  paintSeat();
}

function paintSeat() {
  const el = $("seatTag");
  if (!el) return;
  const mode = pitchMode();
  el.textContent = seatsOf > 1 ? `seat ${seat}/${seatsOf}` : "";
  el.title =
    mode === "assign"
      ? "this part's pitches are shared out by seat; the seats sort themselves"
      : "how many players are on this part";
}

/* ---- what the written pitches mean for this phrase ---- */

/** fixed | choose | assign | drift — "choose" is what a phrase says by saying nothing */
function pitchMode() {
  const written = partPhrase().pitch;
  const mode = typeof written === "string" ? written.toLowerCase() : "";
  if (mode === "fixed" || mode === "assign" || mode === "drift") return mode;
  return "choose";
}

/**
 * A drifting phrase's band: the lowest and highest of its written notes, and
 * everything between them. The notes are the edges and the landmarks, not a
 * list of the only pitches allowed — that is the whole difference between
 * "drift" and "choose".
 *
 * An explicit "range": [low, high] still wins if a phrase writes one, but
 * nothing in the score does.
 */
function pitchRange() {
  const written = partPhrase().range;
  if (Array.isArray(written) && written.length >= 2) {
    const low = parsePitch(written[0]);
    const high = parsePitch(written[1]);
    if (low !== null && high !== null) return { low: Math.min(low, high), high: Math.max(low, high) };
  }
  const notes = allowedNotes();
  if (notes.length < 2) return null;
  return { low: Math.min.apply(null, notes), high: Math.max.apply(null, notes) };
}

/* A freely chosen pitch belongs to the phrase it was chosen in, not to the
   player's last move: step away to phrase 3 and back and you are where you
   left off, not reset to the top of the list. */
const chosenNotes = new Map(); // "partId:phrase" -> the pitch picked there
const pitchKey = () => `${part().id}:${phraseIndex}`;

function rememberChoice() {
  const mode = pitchMode();
  if (mode === "choose" || mode === "drift") chosenNotes.set(pitchKey(), note);
}

/**
 * The pitch this player should be on for this phrase.
 *
 *   fixed   the one written pitch, no argument
 *   assign  the seat's share of the written pitches, cycling — three players on
 *           two pitches gives 1, 2, 1, so both are always heard
 *   choose  whatever the player picked here before, as long as it is on the list
 *   drift   a fresh draw inside the written range, re-drawn as they play
 */
function pitchForPhrase() {
  const mode = pitchMode();
  const allowed = allowedNotes();
  if (!allowed.length) return null;
  if (mode === "fixed") return allowed[0];
  if (mode === "assign") return allowed[(Math.max(1, seat) - 1) % allowed.length];
  // "choose" still hands out a starting pitch by seat, the same way assign does,
  // so a part that opens on a chord opens on the whole chord rather than four
  // players all on the first written note. The difference is that nothing keeps
  // them there: the chips, the keyboard and J all still work.
  const bySeat = allowed[(Math.max(1, seat) - 1) % allowed.length];
  const remembered = chosenNotes.get(pitchKey());
  const wanted = remembered === undefined ? bySeat : remembered;
  if (mode === "drift") {
    // anywhere in the band counts as a pitch this player already owns
    const band = pitchRange();
    if (!band) return bySeat;
    return wanted >= band.low - 0.01 && wanted <= band.high + 0.01 ? wanted : bySeat;
  }
  return allowed.some((n) => Math.abs(n - wanted) < 0.01) ? wanted : bySeat;
}

/**
 * J — move to a different one of this phrase's pitches.
 *
 * With two written pitches this alternates, because "a different one" has only
 * one answer. With three or more it is a fresh draw from the others, so two
 * players leaning on J do not march in step.
 */
function rerollChoice() {
  // A band is not a set, so there is no "a different one of them" to jump to.
  // In a drifting phrase the pitch is the player's hand on the piano, and J
  // deliberately does nothing.
  if (pitchMode() === "drift") return;
  const allowed = allowedNotes();
  const others = allowed.filter((n) => Math.abs(n - note) > 0.01);
  if (!others.length) return;
  const next = others[Math.floor(Math.random() * others.length)];
  applyRemote("/scan/note", [next]);
  flashPreset(`pitch → ${pitchLabel(next)}`);
}

/* ================================================================ *
 *  the projection feed
 *
 *  A stage page (scan/stage.html) draws every player's vocal tract for the
 *  audience. It has no synth of its own, so each player sends the real thing:
 *  the 44 tract diameters the upstream visualiser is drawing from, plus what it
 *  takes to colour them. Nothing goes on the wire unless a stage has said hello
 *  in the last few seconds, so a rehearsal with no projector costs nothing.
 * ================================================================ */

const STAGE_FPS = Number(SEARCH.get("stagefps")) || 20;
let stageSeenAt = 0;
let feedTimer = null;
let feedStartedUI = false;

/** the upstream UI keeps a mirror of the tract on this thread — but only while
 *  its animation loop is running, which is why the feed keeps it running */
function tractMirror() {
  const ui = element && element.UI && element.UI._tractUI;
  const processor = ui && ui._processor;
  return processor && processor.tract ? processor.tract : null;
}

function stageIsWatching() {
  return performance.now() - stageSeenAt < 6000;
}

/**
 * The words, for the stage's subtitles. Sent when the phrase changes and on a
 * slow heartbeat — the text is the same thirty-odd characters every frame, and
 * the tract frames are busy enough without carrying it twenty times a second.
 */
function sendPhraseState() {
  if (!stageIsWatching()) return;
  const p = part();
  sendOut("/tract/phrase", [p.id, MACHINE, phraseIndex + 1, PHRASES[phraseIndex] || ""]);
}

function sendTractFrame() {
  if (!ready || !stageIsWatching()) return;
  const tract = tractMirror();
  if (!tract) return;
  const length = tract.length || 44;
  const d = new Array(length);
  for (let i = 0; i < length; i++) d[i] = Math.round((Number(tract.diameter[i]) || 0) * 100) / 100;
  let amplitude = 0;
  try {
    amplitude =
      (tract.amplitude.max[length - 1] || 0) +
      (tract.nose.amplitude.max[tract.nose.length - 1] || 0);
  } catch (e) {
    /* a different shape upstream; the drawing just will not shimmer */
  }
  const p = part();
  sendOut("/tract/frame", [
    p.id,
    MACHINE,
    JSON.stringify({
      d,
      lip: (tract.lip && tract.lip.start) || length - 5,
      a: Math.round(amplitude * 1000) / 1000,
      i: Math.round((voice ? voice.gate : 0) * 100) / 100,
      v: whisperOn ? 0 : 1,
      f: Math.round(note * 10) / 10,
    }),
  ]);
}

/**
 * While a stage is watching, the tract mirror has to keep ticking even for a
 * player who has folded the panel away — so the feed starts the visualiser
 * itself, and hands it back when the stage goes quiet.
 */
function tendTractFeed() {
  // not before the element has its audio context and its UI object: starting
  // the upstream visualiser mid-setup throws inside its own animation frame,
  // where nothing here can catch it
  if (!ready || !element || !element.UI) return;
  const watching = stageIsWatching();
  const showing = $("tractHost") && $("tractHost").classList.contains("on");
  if (watching && !showing && element && !feedStartedUI) {
    try {
      element.enableUI();
      element.startUI();
      feedStartedUI = true;
    } catch (e) {
      /* no UI here; the stage simply will not see this player */
    }
  } else if (!watching && feedStartedUI) {
    if (element && !showing) element.stopUI();
    feedStartedUI = false;
  }
}

clearInterval(feedTimer);
feedTimer = setInterval(() => {
  tendTractFeed();
  sendTractFrame();
}, Math.max(20, Math.round(1000 / STAGE_FPS)));
setInterval(sendPhraseState, 2000);

/**
 * Tell the conductor this part is here, so the roster lights up. The machine id
 * is this tab's own, kept for the session, so two laptops on the same part are
 * counted as two — which is the normal case in this piece.
 */
/* Generated fresh for every page instance and kept in memory only. It used to
 * live in sessionStorage — but a browser copies sessionStorage into a
 * duplicated tab, so three players opened that way all claimed to be the same
 * machine: the conductor counted one, and the stage drew one tile flickering
 * between three different tracts. A reload now looks like a new machine, which
 * the roster and the stage both forget on their own after a few seconds. */
const MACHINE = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 8)}`;

function sayHello() {
  const p = part();
  sendOut("/player/hello", [
    p.id,
    p.name,
    cued.cue === null ? -1 : Number(cued.cue) || 0,
    MACHINE,
    // Players advance their own phrase, so the desk has no way of knowing
    // where anyone is unless they say. 0 is standby, 1-8 the phrases. This
    // rides on the hello rather than on /tract/phrase because that one is only
    // sent when a projection is listening, and the conductor needs it whether
    // or not anyone is running the stage.
    phraseIndex + 1,
    // what this laptop is called, if its player typed it in. Empty is fine —
    // the desk falls back to the part and a seat number.
    playerName,
  ]);
}

/* ================================================================ *
 *  where this player is in the phrase, for the conductor
 *
 *  A phrase is thirty seconds of somebody moving a playhead, and four of
 *  those at once is not something you can hear apart. So the desk gets a
 *  little strip per laptop, and this is what feeds it: position, whether the
 *  gate is open, and whether it is voiced or whispered.
 *
 *  It only goes out while a desk is listening. The conductor's page pings on
 *  its heartbeat; between pings there is nobody to draw it, and the piece
 *  does not need eight laptops talking ten times a second to nobody.
 * ================================================================ */

const DESK_FPS = 10;
let deskSeenAt = 0;
let wordsDirty = true;
let wordsSentAt = 0;

function deskIsWatching() {
  return performance.now() - deskSeenAt < 7000;
}

/**
 * The words of this phrase and where they sit, for the desk's miniature.
 *
 * Sent when the track changes and then only every few seconds — it is the one
 * thing on this wire that does not move, and re-sending a phrase's layout ten
 * times a second would be ten times a second of the same forty bytes. The
 * repeat is for a desk that opened after the phrase did.
 */
function sendWords() {
  if (!deskIsWatching() || !ws || ws.readyState !== 1) return;
  const now = performance.now();
  if (!wordsDirty && now - wordsSentAt < 4000) return;
  wordsDirty = false;
  wordsSentAt = now;
  const p = part();
  sendOut("/player/words", [p.id, MACHINE, phraseIndex + 1, JSON.stringify(wordLayout())]);
}

function sendPlayhead() {
  if (!deskIsWatching() || !ws || ws.readyState !== 1) return;
  sendWords();
  const p = part();
  const i = Math.max(0, Math.min(cells.length - 1, Math.floor(targetPos)));
  sendOut("/player/at", [
    p.id,
    MACHINE,
    playerName,
    phraseIndex + 1, // 0 is standby
    Math.round(posFraction(targetPos) * 1000) / 1000,
    cells.length,
    (cells[i] && cells[i].ipa) || "",
    // what is actually coming out, not what the Z latch says: Q and T flip the
    // voice for the length of a percussive hit without touching the latch, and
    // a hit is exactly the kind of thing the desk is watching for
    (ready && voice ? voice.whisper : whisperOn) ? 1 : 0,
    ready && voice && voice.gate > 0 ? 1 : 0,
  ]);
}
setInterval(sendPlayhead, Math.round(1000 / DESK_FPS));
setInterval(() => {
  if (ws && ws.readyState === 1) sayHello();
}, 4000);

function saveInstruction(text) {
  const p = part();
  if (!p.phrases) p.phrases = [];
  if (!p.phrases[phraseIndex]) p.phrases[phraseIndex] = {};
  p.phrases[phraseIndex].instruction = text;
}

/** says how this phrase decided your pitch, in as few words as it can */
function paintPitchTag() {
  const el = $("pitchTag");
  if (!el) return;
  const mode = pitchMode();
  const band = mode === "drift" ? pitchRange() : null;
  const words = {
    fixed: "pitch: written",
    assign: `pitch: yours by seat`,
    choose: "pitch: your choice",
    drift: band
      ? `pitch: anywhere ${pitchLabel(band.low)}\u2013${pitchLabel(band.high)}`
      : "pitch: your choice",
  };
  el.textContent = words[mode] || "";
  paintSeat();
}

/** the chips beside the piano: this part's pitches for this phrase */
function paintNoteChoices() {
  const host = $("noteChoices");
  if (!host) return;
  const allowed = allowedNotes();
  const mode = pitchMode();
  const range = pitchRange();
  paintPitchTag();
  host.innerHTML = "";

  // A drifting phrase keeps its chips: they are the written landmarks, and
  // clicking one is as good as clicking the piano. What makes it a band rather
  // than a set is the lit keys between them, not the absence of chips.
  if (allowed.length === 0) {
    const free = document.createElement("span");
    free.className = "note-free";
    free.textContent = "any pitch";
    host.appendChild(free);
    return;
  }
  void range;
  const mine = mode === "assign" ? pitchForPhrase() : null;
  allowed.forEach((n) => {
    const chip = document.createElement("button");
    chip.className =
      "note-chip" +
      (Math.abs(n - note) < 0.01 ? " on" : "") +
      (mine !== null && Math.abs(n - mine) < 0.01 ? " mine" : "");
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
  // the phrase steppers and the dots are composer tools: a player moves with
  // the number keys or the brackets, and nothing on screen invites a mis-click
  ["prevPhrase", "nextPhrase", "phraseDots"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = !composerMode;
  });

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
      const wrote = await writeJSON("/scan/parts.json", partsFile(), {
        fallback: "none",
        quiet: true,
      });
      if (wrote) flashPreset(`instruction for ${part().name} → scan/parts.json`);
    });
  }
  $("partsExport").addEventListener("click", () => writeJSON("/scan/parts.json", partsFile()));
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

/**
 * parts.json as it should be written: every phrase entry stamped with the line
 * it belongs to — `"_comment": "5 — slip, slide, perish"` — and that stamp put
 * first, so opening the file in an editor tells you which phrase you are looking
 * at without counting braces. The app never reads it back; PHRASES is still the
 * authority, which is why it is rewritten on every save rather than trusted.
 */
function partsFile() {
  const stamped = parts.map((p) =>
    Object.assign({}, p, {
      phrases: (p.phrases || []).map((entry, i) => {
        const rest = Object.assign({}, entry);
        delete rest._comment;
        const label = PHRASES[i] ? `${i + 1} — ${PHRASES[i]}` : String(i + 1);
        return Object.assign({ _comment: label }, rest);
      }),
    })
  );
  return Object.assign({}, partsDoc, { parts: stamped });
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
      ? "the bridge is an older build — restart node scan/scan-bridge.js"
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
  get name() {
    return playerName;
  },
  set name(text) {
    setName(text);
  },
  get cued() {
    return { ...cued };
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
  wordLayout,
  posFraction,
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
  resetEngine,
  get whisper() {
    return whisperOn;
  },
  get note() {
    return note;
  },
  /** who this page thinks it is within its part, and how the phrase hands out pitch */
  startFade,
  cancelFade,
  get fade() {
    return { seconds: fadeSeconds, running: fading, gain: fadeNode ? fadeNode.gain.value : 1 };
  },
  get seating() {
    return { machine: MACHINE, seat, of: seatsOf, mode: pitchMode(), range: pitchRange() };
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


/* ================================================================ *
 *  output: the fader at the top of the page, and a meter beside it
 * ================================================================ */

/** the header fader and the one in *timing & voice* are the same number */
function setMasterGain(value, { fromSlider = false } = {}) {
  gain = Math.max(0, Math.min(1, value));
  if (master) master.gain.setTargetAtTime(gain, ctx.currentTime, 0.02);
  const slider = $("masterGain");
  const out = $("masterGainOut");
  if (slider && !fromSlider) slider.value = String(gain);
  if (out) out.textContent = gain.toFixed(2);
  syncControl("gain", gain);
}

const METER = { peak: 0, hold: 0, holdAt: 0 };

function startMeter() {
  const canvas = $("meter");
  if (!canvas || !meterNode) return;
  const ctx2d = canvas.getContext("2d");
  const read = () => {
    requestAnimationFrame(read);
    if (!meterNode) return;
    meterNode.getFloatTimeDomainData(meterBuffer);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < meterBuffer.length; i++) {
      const v = meterBuffer[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / meterBuffer.length);
    // fast up, slow down: a burst should be visible, not a flicker you miss
    METER.peak = peak > METER.peak ? peak : METER.peak * 0.86 + peak * 0.14;
    const now = performance.now();
    if (peak >= METER.hold || now - METER.holdAt > 1200) {
      METER.hold = peak;
      METER.holdAt = now;
    }
    paintMeter(ctx2d, canvas, METER.peak, rms, METER.hold);
  };
  read();
}

const dbfs = (v) => (v <= 1e-6 ? -120 : 20 * Math.log10(v));
/** -60 dB at the left edge, 0 dB at the right */
const meterX = (v, width) => Math.max(0, Math.min(1, (dbfs(v) + 60) / 60)) * width;

function paintMeter(g, canvas, peak, rms, hold) {
  const css = getComputedStyle(document.documentElement);
  const width = canvas.width;
  const height = canvas.height;
  g.clearRect(0, 0, width, height);
  g.fillStyle = css.getPropertyValue("--vowel").trim() || "#4f7cff";
  g.globalAlpha = 0.35;
  g.fillRect(0, 0, meterX(peak, width), height); // the envelope
  g.globalAlpha = 1;
  g.fillRect(0, 0, meterX(rms, width), height); // and the body of the sound
  // the last peak, held for a moment, in the warning colour once it is close
  const x = meterX(hold, width);
  g.fillStyle = (dbfs(hold) > -3 ? css.getPropertyValue("--bad") : css.getPropertyValue("--hot")).trim();
  g.fillRect(Math.max(0, x - 2), 0, 2, height);
  const label = $("meterPeak");
  if (label) {
    label.textContent = hold <= 1e-6 ? "—" : `${dbfs(hold).toFixed(1)} dB`;
    label.classList.toggle("hot", dbfs(hold) > -3);
  }
}

/* ================================================================ *
 *  which skin
 * ================================================================ */

function paintThemeSwitch() {
  const button = $("themeSwitch");
  if (!button) return;
  button.textContent = document.documentElement.dataset.theme === "dark" ? "skin: dark" : "skin: pink";
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  if (dark) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = "dark";
  try {
    localStorage.setItem("tract.theme", dark ? "pink" : "dark");
  } catch (e) {}
  paintThemeSwitch();
}

$("startAudio").addEventListener("click", () => enableAudio());
$("record").addEventListener("click", () => {
  if (recorder) stopRecordingAndDownload();
  else if (!startRecording()) enableAudio();
});
$("masterGain").addEventListener("input", (event) =>
  setMasterGain(Number(event.target.value), { fromSlider: true })
);
$("masterGain").addEventListener("pointerup", (event) => setTimeout(() => event.target.blur(), 0));
// note names on every key: off by default, remembered per browser
const LABELS_STORE = "tract.pianoLabels";
function paintPianoLabels(on) {
  const host = $("piano");
  const button = $("pianoLabels");
  if (host) host.classList.toggle("labelled", on);
  if (button) {
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.classList.toggle("on", on);
  }
}
if ($("pianoLabels")) {
  let labelled = false;
  try {
    labelled = localStorage.getItem(LABELS_STORE) === "1";
  } catch (e) {
    /* private window */
  }
  paintPianoLabels(labelled);
  $("pianoLabels").addEventListener("click", () => {
    labelled = !labelled;
    paintPianoLabels(labelled);
    try {
      localStorage.setItem(LABELS_STORE, labelled ? "1" : "0");
    } catch (e) {
      /* private window */
    }
  });
}

$("themeSwitch").addEventListener("click", toggleTheme);
paintThemeSwitch();
setMasterGain(gain);
$("prevPhrase").addEventListener("click", () => stepPhrase(-1));
$("nextPhrase").addEventListener("click", () => stepPhrase(1));

function showTract(on) {
  if (!element) return;
  const host = $("tractHost");
  if (host.classList.contains("on") === on) return;
  toggleTract();
}

$("toggleTract").addEventListener("click", (event) => {
  // it sits inside the panel's <summary>, so the click would fold the panel too
  event.preventDefault();
  event.stopPropagation();
  toggleTract();
});

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
    $("toggleTract").textContent = "hide";
  } else {
    element.stopUI();
    $("toggleTract").textContent = "show";
  }
}

/**
 * Settings baked into a cell when the strip is built, rather than read live by
 * the engine. Changing one of these has to rebuild the strip or it does nothing
 * until the next phrase change — which is what used to happen to every one of
 * them except `holdWordFinalStops`.
 */
const REBUILD_KEYS = new Set([
  "holdWordFinalStops",
  "voicenessVowel",
  "voicenessVoicedFric",
  "voicenessVoicelessFric",
  "sibilantLevel",
  "closureIntensityVoiced",
  "pressureVoiceless",
  "burstIntensity",
]);

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
    else if (key === "q") {
      startRandomPhoneme();
      heldShot = "q";
    } else if (key === "t") {
      startPercussion();
      heldShot = "t";
    }
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
      // the end of the piece. Phrases moved to [ and ] so this cannot be hit
      // on the way to the next one.
      startFade();
      break;
    case "ArrowUp":
      cancelFade();
      break;
    case "]":
      stepPhrase(1);
      break;
    case "[":
      stepPhrase(-1);
      break;
    case " ":
      // held, not toggled — see the damper pedal above
      event.preventDefault();
      if (event.repeat) break;
      pressPedal();
      break;
    case "Escape":
      // the panic key. Cue 12 is "Stop. Silence." and until now there was no
      // way to do that in the middle of a word.
      event.preventDefault();
      stopTransport();
      break;
    case "Home":
      targetPos = 0;
      atEnd = false;
      break;
    case "j":
    case "J":
      rerollChoice();
      break;
    default:
      // 0 is standby, 1–8 are the phrases
      if (/^[0-8]$/.test(event.key)) setPhrase(Number(event.key) - 1);
  }
});

document.addEventListener("keyup", (event) => {
  if (isTyping(event.target)) return;
  const key = event.key.toLowerCase();
  if (key in HOLD_KEYS) {
    event.preventDefault();
    stopScan(key);
  }
  if (key === "q" || key === "t") {
    event.preventDefault();
    releaseShot(key);
  }
  if (event.key === " ") {
    event.preventDefault();
    liftPedal();
  }
});
window.addEventListener("blur", () => {
  stopScan();
  heldShot = null;
  liftPedal(); // nothing held survives losing focus
  endHeldShot();
});

// the dictionary loads itself over XHR; wait for it, then seed the strip
(function waitForDict(tries = 0) {
  if (dictReady() || tries > 200) {
    loadName();
    wireNameChip();
    Promise.all([loadParts(), loadPresets()]).then(() => {
      setPhrase(STANDBY, { announce: false }); // the page opens before the piece does
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
