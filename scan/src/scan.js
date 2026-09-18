/*
  scan/src/scan.js — page glue: audio, strip UI, transports.
  The articulation logic lives in engine.js; the worklet repair in
  patched-pink-trombone.js.
*/

import { ScanVoice, buildTrack, DEFAULTS, OPEN } from "./engine.js";
import { loadPatchedPinkTrombone } from "./patched-pink-trombone.js";

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

// seconds per phoneme for each scan rate; a fresh value is drawn per cell
const RATES = {
  slow: [4, 6],
  mid: [1, 3],
  fast: [0.5, 1],
};
const rand = (a, b) => a + Math.random() * (b - a);

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

let targetPos = 0.5;
let pressed = false; // pointer is down
let insideStrip = false;
let explicitGate = null; // null = follow the pointer, 0/1 = forced by OSC/MIDI
let lastGesture = "—";
let lastGestureAt = 0;
let note = 45.5; // ≈140 Hz, the Pink Trombone default
let ws = null;

let gain = 0.9;
const vibrato = { rate: 6, depth: 0.005, wobble: 1 };
let wordMode = "next"; // or "random", per phrase
let wordSpans = [];
let wordCursor = -1;
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
  const patchPill = $("patchStatus");
  patchPill.textContent = `worklet: ${applied.length}/${missed.length + applied.length} patched`;
  patchPill.className = "pill " + (missed.length === 0 ? "on" : "off");
  patchPill.title = missed.length
    ? `could not apply: ${missed.join(", ")} — upstream source changed?`
    : "plosive burst transients repaired";

  element = document.createElement("pink-trombone");
  $("tractHost").appendChild(element);
  await element.setAudioContext(ctx);

  master = ctx.createGain();
  master.gain.value = 0.9;
  // a safety limiter: burst transients are impulsive and were peaking near 0 dBFS
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;
  element.connect(master);
  master.connect(limiter);
  limiter.connect(ctx.destination);
  limiterNode = limiter;
  element.pinkTrombone.start();

  const front = element.newConstriction(41, OPEN);
  const back = element.newConstriction(10.5, OPEN);

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

  applyVibrato();
  master.gain.value = gain;

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
  renderAlts();
  rebuildFromWords();
  applyPreset(phraseIndex);
  wordCursor = -1;
  atEnd = false;
  targetPos = 0;
  if (announce) sendOut("/scan/out/phrase", [phraseIndex + 1, phrase]);
}

function rebuildFromWords() {
  const parts = [];
  wordLabels = [];
  words.forEach((w) => {
    if (w.alts.length === 0) return;
    parts.push(w.alts[w.choice]);
    wordLabels.push(w.token);
    if (w.pause) {
      parts.push(""); // an empty part between two spaces = a second gap cell
      wordLabels.push("");
    }
  });
  const ipa = parts.join(" ");
  ipaLine.textContent = ipa;
  setTrack(ipa);
}

function renderAlts() {
  altsHost.innerHTML = "";
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
  wordCursor = -1;
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
    el.innerHTML =
      `<div class="bar"></div><span class="ipa">${cell.ipa}</span>` +
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
  { key: "votVoiceless", label: "VOT  p t k", min: 0, max: 0.15, step: 0.005, unit: "s" },
  { key: "votVoiced", label: "VOT  b d g", min: 0, max: 0.08, step: 0.002, unit: "s" },
  { key: "transition", label: "burst → next", min: 0.01, max: 0.2, step: 0.005, unit: "s" },
  { key: "affricateClosure", label: "affricate hold", min: 0.01, max: 0.2, step: 0.005, unit: "s" },
  { key: "smooth", label: "scan smoothing", min: 0.005, max: 0.15, step: 0.005, unit: "s" },
  { key: "blend", label: "transition zone", min: 0.05, max: 0.9, step: 0.05, unit: "" },
  { key: "glide", label: "pitch glide", min: 0, max: 0.5, step: 0.01, unit: "s" },
  { key: "note", label: "pitch (MIDI note)", min: 24, max: 84, step: 0.01, unit: "", special: true },
  { key: "tractLength", label: "tract length", min: 15, max: 88, step: 1, unit: "", special: true },
  { key: "gain", label: "output", min: 0, max: 1.5, step: 0.01, unit: "", special: true },
  { key: "vibratoRate", label: "vibrato rate", min: 0.1, max: 12, step: 0.1, unit: "", special: true },
  { key: "vibratoDepth", label: "vibrato depth", min: 0, max: 0.04, step: 0.001, unit: "", special: true },
  { key: "wobble", label: "wobble (pitch drift)", min: 0, max: 1, step: 0.01, unit: "", special: true },
  { key: "whisper", label: "whisper", toggle: true, special: true },
  { key: "autoReleaseStops", label: "held stops release themselves", toggle: true },
];

const controlEls = {};

function buildControls() {
  CONTROLS.forEach((spec) => {
    const wrap = document.createElement("div");
    wrap.className = "ctl" + (spec.toggle ? " toggle" : "");
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
  if (spec.key === "note") return `${n.toFixed(2)}  ${noteName(n)}`;
  return n.toFixed(2);
}

function onControl(spec, value) {
  if (!spec.special) {
    cfg[spec.key] = value;
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

function startScan(rateName, key) {
  if (!ready || pressed) return;
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
  const span = pickWord();
  if (!span) return;
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
const PIANO_LOW = 36; // C2
const PIANO_HIGH = 84; // C6
const BLACK = [1, 3, 6, 8, 10];

function noteName(midi) {
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
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
  host.querySelectorAll(".pkey").forEach((key) => {
    key.classList.toggle("on", Number(key.dataset.note) === nearest);
  });
  const label = $("pianoNote");
  if (label) label.textContent = `${noteName(note)} · ${note.toFixed(2)} · ${(440 * Math.pow(2, (note - 69) / 12)).toFixed(1)} Hz`;
}

/* ================================================================ *
 *  presets, per phrase — for the composer, not the players
 * ================================================================ */

const PRESET_STORE = "tract.presets.v1";
let presets = {}; // phraseIndex -> preset
let presetWhisper = false;
let composerMode = false;

function capturePreset() {
  const out = { cfg: {}, note, gain, wordMode, whisper: presetWhisper, vibrato: Object.assign({}, vibrato) };
  Object.keys(DEFAULTS).forEach((k) => (out.cfg[k] = cfg[k]));
  out.tractLength = voice ? voice.tractLength : 44;
  return out;
}

function applyPreset(index) {
  const preset = presets[index];
  wordMode = (preset && preset.wordMode) || "next";
  const sel = $("wordModeSel");
  if (sel) sel.value = wordMode;
  if (!preset) return;

  Object.keys(DEFAULTS).forEach((k) => {
    if (preset.cfg && k in preset.cfg) {
      cfg[k] = preset.cfg[k];
      syncControl(k, cfg[k]);
    }
  });
  if (typeof preset.note === "number") {
    note = preset.note;
    syncControl("note", note);
    paintPiano();
    if (ready) voice.setNote(note, ctx.currentTime, 0);
  }
  if (typeof preset.gain === "number") {
    gain = preset.gain;
    syncControl("gain", gain);
    if (master) master.gain.value = gain;
  }
  if (preset.vibrato) {
    Object.assign(vibrato, preset.vibrato);
    syncControl("vibratoRate", vibrato.rate);
    syncControl("vibratoDepth", vibrato.depth);
    syncControl("wobble", vibrato.wobble);
    applyVibrato();
  }
  if (typeof preset.tractLength === "number") {
    syncControl("tractLength", preset.tractLength);
    if (ready) voice.setTractLength(preset.tractLength, ctx.currentTime);
  }
  presetWhisper = !!preset.whisper;
  syncControl("whisper", presetWhisper);
  if (ready) voice.setWhisper(presetWhisper, ctx.currentTime);
}

async function loadPresets() {
  // a presets.json committed beside the page is the shipped set...
  try {
    const response = await fetch("/scan/presets.json", { cache: "no-cache" });
    if (response.ok) presets = await response.json();
  } catch (e) {
    /* none bundled */
  }
  // ...and anything saved in this browser wins over it, for tuning in place
  try {
    const local = localStorage.getItem(PRESET_STORE);
    if (local) Object.assign(presets, JSON.parse(local));
  } catch (e) {}
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
  const row = $("presetRow");
  if (!row) return;
  row.hidden = !composerMode;
  if (!composerMode) return;

  $("presetSave").addEventListener("click", () => {
    presets[phraseIndex] = capturePreset();
    persistPresets();
    flashPreset(`saved to phrase ${phraseIndex + 1}`);
  });
  $("presetRevert").addEventListener("click", () => {
    applyPreset(phraseIndex);
    flashPreset("reverted");
  });
  $("presetClear").addEventListener("click", () => {
    delete presets[phraseIndex];
    persistPresets();
    Object.keys(DEFAULTS).forEach((k) => {
      cfg[k] = DEFAULTS[k];
      syncControl(k, cfg[k]);
    });
    flashPreset(`phrase ${phraseIndex + 1} cleared`);
  });
  $("wordModeSel").addEventListener("input", (event) => {
    wordMode = event.target.value;
  });
  $("presetExport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "presets.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    flashPreset("exported — commit it as scan/presets.json");
  });
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

window.scan = {
  applyRemote,
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

$("toggleTract").addEventListener("click", () => {
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
});

const HOLD_KEYS = { a: "slow", s: "mid", d: "fast" };
const SHOT_KEYS = { w: "slow", e: "mid", r: "fast" };

document.addEventListener("keydown", async (event) => {
  if (event.target && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();

  if (key in HOLD_KEYS || key in SHOT_KEYS || key === "q" || key === "t") {
    event.preventDefault();
    if (event.repeat) return;
    if (!ctx) await enableAudio();
    if (key in HOLD_KEYS) startScan(HOLD_KEYS[key], key);
    else if (key in SHOT_KEYS) startWord(SHOT_KEYS[key]);
    else if (key === "q") startRandomPhoneme();
    else if (key === "t") startPercussion();
    return;
  }

  const stepSize = event.shiftKey ? 0.02 : 0.1;
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
    loadPresets().then(() => setPhrase(0, { announce: false }));
    return;
  }
  setTimeout(() => waitForDict(tries + 1), 100);
})();
