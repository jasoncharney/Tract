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
const textInput = $("text");
const ipaInput = $("ipa");
const altsHost = $("alts");
const readout = $("readout");
const controlsHost = $("controls");

const cfg = Object.assign({}, DEFAULTS);

// ?nopatch=1 loads the upstream worklet untouched, for A/B-ing the burst fix
const SEARCH = new URLSearchParams(location.search);
const NO_PATCH = SEARCH.has("nopatch");
const PATCH_NAMES = SEARCH.has("patches") ? SEARCH.get("patches").split(",") : null;

// `phonemes` is a top-level `const` inside src/utils.js, so it lives in the
// global *lexical* environment and never appears on `window`
function phonemeTable() {
  if (typeof phonemes !== "undefined" && phonemes) return phonemes;
  return window.phonemes || {};
}

let ctx = null;
let element = null;
let voice = null;
let master = null;
let ready = false;

let cells = [];
let cellEls = [];
let rects = [];
let wordLabels = [];

let targetPos = 0.5;
let explicitGate = null; // null = follow the pointer, 0/1 = forced
let lastGesture = "—";
let lastGestureAt = 0;
let note = 45.5; // ≈140 Hz, the Pink Trombone default
let ws = null;

/* ================================================================ *
 *  audio
 * ================================================================ */

async function enableAudio() {
  if (ctx) {
    await ctx.resume();
    return;
  }
  ctx = new AudioContext();

  const { applied, missed } = await loadPatchedPinkTrombone({ patch: !NO_PATCH, names: PATCH_NAMES });
  const patchPill = $("patchStatus");
  patchPill.textContent = `worklet: ${applied.length}/${missed.length + applied.length} patched`;
  patchPill.className = "pill " + (missed.length === 0 ? "on" : "off");
  patchPill.title = missed.length
    ? `could not apply: ${missed.join(", ")} — upstream source changed?`
    : "plosive burst transients repaired";

  element = document.createElement("pink-trombone");
  $("tractHost").appendChild(element);
  element.style.display = "none";
  await element.setAudioContext(ctx);

  master = ctx.createGain();
  master.gain.value = 0.9;
  element.connect(master);
  master.connect(ctx.destination);
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

  ready = true;
  $("startAudio").textContent = "audio running";
  $("startAudio").classList.remove("primary");
  window.scan.voice = voice;
  window.scan.ctx = ctx;
  window.scan.element = element;
}

/* ================================================================ *
 *  text / IPA
 * ================================================================ */

let words = [];

function dictReady() {
  return (
    window.TextToIPA &&
    TextToIPA._IPADict &&
    Object.keys(TextToIPA._IPADict).length > 0
  );
}

function setText(value, { rebuild = true } = {}) {
  if (textInput.value !== value) textInput.value = value;
  words = value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const alts = dictReady() ? (TextToIPA._IPADict[word] || []).slice() : [];
      return { word, alts, choice: 0 };
    });
  renderAlts();
  if (rebuild) rebuildFromWords();
}

function rebuildFromWords() {
  const used = words.filter((w) => w.alts.length > 0);
  wordLabels = used.map((w) => w.word);
  const ipa = used.map((w) => w.alts[w.choice]).join(" ");
  ipaInput.value = ipa;
  setTrack(ipa);
}

function renderAlts() {
  altsHost.innerHTML = "";
  words.forEach((w, i) => {
    if (w.alts.length <= 1) return;
    const select = document.createElement("select");
    w.alts.forEach((alt, index) => {
      const option = new Option(`${w.word}: ${alt}`, String(index));
      select.appendChild(option);
    });
    select.value = String(w.choice);
    select.addEventListener("input", () => {
      w.choice = Number(select.value);
      rebuildFromWords();
    });
    altsHost.appendChild(select);
  });
}

function setTrack(ipa) {
  cells = buildTrack(ipa, phonemeTable(), cfg);
  renderStrip();
  if (voice) voice.setTrack(cells);
  targetPos = Math.min(targetPos, Math.max(0.001, cells.length - 0.001));
}

/* ================================================================ *
 *  the strip
 * ================================================================ */

const CLASS_TAG = {
  vowel: "vowel",
  stop: "stop",
  affricate: "affr",
  fricative: "fric",
  aspirate: "asp",
  nasal: "nasal",
  approximant: "appr",
  silence: "",
};

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

  cells.forEach((cell, i) => {
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
    el.style.flex = String(cell.width);
    el.title = `${cell.ipa} — ${cell.cls}${cell.example ? ` (as in "${cell.example}")` : ""}`;
    el.innerHTML =
      `<div class="bar"></div><span class="ipa">${cell.ipa}</span>` +
      `<span class="tag">${CLASS_TAG[cell.cls] || ""}</span>`;
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

strip.addEventListener("pointermove", (event) => {
  targetPos = posFromX(event.clientX);
  if (explicitGate === null && voice && ready) openGate(true);
});
strip.addEventListener("pointerenter", (event) => {
  measure();
  targetPos = posFromX(event.clientX);
  if (explicitGate === null) openGate(true);
});
strip.addEventListener("pointerleave", () => {
  if (explicitGate === null) openGate(false);
});
strip.addEventListener("pointerdown", (event) => {
  strip.setPointerCapture(event.pointerId);
  if (!ctx) enableAudio();
});

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

  voice.update(targetPos, ctx.currentTime);

  // cursor
  const stripRect = strip.getBoundingClientRect();
  cursor.style.opacity = voice.gate > 0 ? "1" : "0.25";
  cursor.style.left = `${xFromPos(targetPos) - stripRect.left}px`;

  // active / closed cell
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
  const text =
    `pos <b>${targetPos.toFixed(2)}</b>` +
    ` · cell <b>${cell ? cell.ipa : "—"}</b> (${cell ? cell.cls : "—"})` +
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
      if (explicitGate === null) openGate(true);
      break;
    case "/scan/norm":
      targetPos = Math.max(0, Math.min(cells.length - 0.001, num(a0) * cells.length));
      if (explicitGate === null) openGate(true);
      break;
    case "/scan/index":
      targetPos = Math.max(0, Math.min(cells.length - 0.001, Math.floor(num(a0)) + 0.5));
      if (explicitGate === null) openGate(true);
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
    case "/scan/note":
      note = num(a0, note);
      if (ready) voice.setNote(note, now);
      syncControl("note", note);
      break;
    case "/scan/bend":
      if (ready) voice.setBend(num(a0), now);
      break;
    case "/scan/glide":
      cfg.glide = num(a0, cfg.glide);
      syncControl("glide", cfg.glide);
      break;
    case "/scan/text":
      setText(String(a0 ?? ""));
      break;
    case "/scan/phonemes":
      ipaInput.value = String(a0 ?? "");
      wordLabels = [];
      setTrack(ipaInput.value);
      break;
    case "/scan/param":
      if (typeof a0 === "string" && a0 in cfg) {
        cfg[a0] = typeof cfg[a0] === "boolean" ? num(args[1]) > 0.5 : num(args[1], cfg[a0]);
        syncControl(a0, cfg[a0]);
      }
      break;
    case "/scan/speed": {
      // scale every gesture time at once: 1 = as written, 2 = twice as fast
      const k = Math.max(0.1, num(a0, 1));
      ["closeTime", "burstTime", "votVoiceless", "votVoiced", "transition", "affricateClosure"].forEach(
        (key) => {
          cfg[key] = DEFAULTS[key] / k;
          syncControl(key, cfg[key]);
        }
      );
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
      if (master) master.gain.setTargetAtTime(num(a0, 0.9), now, 0.02);
      syncControl("gain", num(a0, 0.9));
      break;
    case "/scan/vibrato/rate":
      if (ready) element.vibrato.frequency.setTargetAtTime(num(a0, 6), now, 0.02);
      break;
    case "/scan/vibrato/depth":
      if (ready) element.vibrato.gain.setTargetAtTime(num(a0, 0.005), now, 0.02);
      break;
    case "/scan/vibrato/wobble":
      if (ready) element.vibrato.wobble.setTargetAtTime(num(a0, 1), now, 0.02);
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
  { key: "whisper", label: "whisper", toggle: true, special: true },
  { key: "autoReleaseStops", label: "stops release themselves", toggle: true },
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
  if (key === "tractLength") return 44;
  if (key === "gain") return 0.9;
  return 0;
}

function formatValue(value, spec) {
  const n = Number(value);
  return spec.unit === "s" ? `${(n * 1000).toFixed(0)} ms` : n.toFixed(2);
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
      applyRemote("/scan/whisper", [value ? 1 : 0]);
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
 *  recording — taps the master output and writes a .wav.
 *  Handy for keeping a take, and it is also what the test harness uses.
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
  master.connect(node);
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
    master.disconnect(node);
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
 *  boot
 * ================================================================ */

window.scan = {
  applyRemote,
  cfg,
  startRecording,
  collectRecording,
  stopRecordingAndDownload,
  get cells() {
    return cells;
  },
  get position() {
    return targetPos;
  },
  set position(p) {
    applyRemote("/scan/position", [p]);
  },
  isReady: () => ready,
  enableAudio,
};

buildControls();
connectWS();
connectBroadcast();
connectMax();

$("startAudio").addEventListener("click", () => enableAudio());
$("record").addEventListener("click", () => {
  if (recorder) stopRecordingAndDownload();
  else if (!startRecording()) enableAudio();
});
$("toggleTract").addEventListener("click", () => {
  if (!element) return;
  const hidden = element.style.display === "none";
  if (hidden) {
    element.style.display = "";
    element.enableUI();
    element.startUI();
    $("toggleTract").textContent = "hide tract";
  } else {
    element.style.display = "none";
    element.stopUI();
    $("toggleTract").textContent = "show tract";
  }
});

textInput.addEventListener("input", () => setText(textInput.value));
ipaInput.addEventListener("input", () => {
  wordLabels = [];
  setTrack(ipaInput.value);
});

strip.addEventListener("keydown", (event) => {
  const stepSize = event.shiftKey ? 0.02 : 0.1;
  if (event.key === "ArrowRight") applyRemote("/scan/position", [targetPos + stepSize]);
  if (event.key === "ArrowLeft") applyRemote("/scan/position", [targetPos - stepSize]);
  if (event.key === " ") applyRemote("/scan/gate", [voice && voice.gate > 0 ? 0 : 1]);
});

// the dictionary loads itself over XHR; wait for it, then seed the strip
(function waitForDict(tries = 0) {
  if (dictReady()) {
    setText(textInput.value);
    return;
  }
  if (tries > 200) {
    setTrack("hɛloʊ wɝld");
    return;
  }
  setTimeout(() => waitForDict(tries + 1), 100);
})();
