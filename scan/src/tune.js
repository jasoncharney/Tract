/*
  scan/src/tune.js — tuning the wall without playing the piece.

  Nothing about the drawing lives on this page. It imports the stage's own
  wire.js, look.js, geom.js and wall.js and feeds them twelve recorded
  seconds of Part I (tune-frames.json, recorded by
  experiments/tract-3d/capture-frames.js), so a knob here does exactly what
  it will do on the projector, the camera is aimed by the same aimAt, and
  the tiles are laid out by the same placeGrid and placeRing.

  It reads scan/look.json, and "write look + phrase N" writes it back: the
  look and spread for the whole piece, and that one phrase's angles and
  spread, with every other phrase kept as it is on disk.
*/
const BUILD = "2026-11-16j";
import { KNOBS, ANGLES, SURFACES, defaults, aimAt, spreadFor } from "./look.js";
import { drawWire, easeFrame } from "./wire.js";
import { placeGrid, placeRing, ringHole, RING_HOLE_FROM } from "./wall.js";

const $ = (id) => document.getElementById(id);
const RATE = 20;               // the stage is fed at twenty a second
const PHRASES = 8;
const PART_NAMES = ["I", "II", "III", "IV"];
// room.js's premiere seating: three on I, two on each of the others
const SEATINGS = { 9: [1, 1, 1, 2, 2, 3, 3, 4, 4], 4: [1, 2, 3, 4], 1: [1] };

const frames = await (await fetch("/scan/tune-frames.json", { cache: "no-cache" })).json();
const LENGTH = frames.length / RATE;

/* ---------------- what is being tuned, and what it started as ---------------- */

let file = null;               // look.json as read, for "changed" and for reload
let look = defaults();
let phrases = {};              // phrase -> part -> { yaw, pitch, perspective }
let spread = { yaw: 0.22, pitch: 0.1 };
let phrase = 1;
let shuffle = 0;

const clone = (x) => JSON.parse(JSON.stringify(x));

async function load() {
  try {
    const response = await fetch("/scan/look.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(response.status);
    file = await response.json();
    $("source").textContent = "read /scan/look.json";
  } catch (e) {
    file = {};
    $("source").textContent = "no /scan/look.json (" + e.message + ") — starting from look.js's defaults";
  }
  look = Object.assign(defaults(), clone(file.look || {}));
  phrases = clone(file.phrases || {});
  spread = Object.assign({ yaw: 0.22, pitch: 0.1 }, clone(file.spread || {}));
  for (const seat of seats) forget(seat);
  goToPhrase(phrase, true);
  buildPanel();
}

/* ---------------- the camera: stage.js's aimFor, against this page's state ---------------- */

/** the desk's anglesFor: only the four parts, only what is saved */
function anglesFor(n) {
  const saved = phrases[String(n)] || {};
  const out = {};
  for (let i = 1; i <= PART_NAMES.length; i++) if (saved[String(i)]) out[String(i)] = saved[String(i)];
  return out;
}
const unsaved = (n) => Object.keys(anglesFor(n)).length === 0;
const freshSeed = () => ((Math.random() * 0xffffffff) >>> 0) || 1;

/** the stage's own aim, against this page's state */
function aimFor(info) {
  return aimAt(info, {
    look,
    angles: anglesFor(phrase),
    spread: spreadFor(phrases, phrase, spread),
    shuffle,
  });
}

/** the desk's lookAtPhrase: a phrase with nothing saved is shuffled */
function goToPhrase(n, force) {
  if (n === phrase && !force) return;
  phrase = n;
  shuffle = unsaved(n) ? freshSeed() : 0;
  $("phrase").value = String(n);
  $("writePhrase").textContent = "write look + phrase " + n;
  paintAngles();
  layout();
}

/* ---------------- the wall ---------------- */

let seats = [];
let layoutMode = "grid";

function forget(info) {
  // what applyLook clears on a change of drawing
  for (const k of ["shown", "heat", "drawn", "cam", "box", "gl", "ipa", "buf", "bufRect"]) info[k] = null;
}

function seat(count) {
  for (const t of document.querySelectorAll(".tile")) t.remove();
  const parts = SEATINGS[count];
  seats = parts.map((part, index) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    const canvas = document.createElement("canvas");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = PART_NAMES[part - 1];
    tile.append(canvas, who);
    $("wall").appendChild(tile);
    // nine in lockstep is the one thing the real wall never shows, so
    // each starts somewhere else in the recording
    return { part, tile, canvas, offset: Math.round((index * frames.length) / parts.length) };
  });
  layout();
}

function layout() {
  const room = document.querySelector("main");
  const W = room.clientWidth, H = room.clientHeight;
  const wantW = Math.min(W, (H * 16) / 9);
  const wall = $("wall");
  const width = Math.round(wantW), height = Math.round((wantW * 9) / 16);
  Object.assign(wall.style, {
    width: width + "px", height: height + "px",
    left: Math.round((W - width) / 2) + "px", top: Math.round((H - height) / 2) + "px",
  });
  // stage.js's layout(): a ring of three or more keeps its words in its
  // hole; otherwise the wall gives up its bottom 15% to them
  const words = wordsOn ? subtitleFor(phrase) : "";
  const inRing = layoutMode === "ring" && seats.length >= RING_HOLE_FROM;
  const tilesH = words && !inRing ? Math.round(height * 0.85) : height;
  const spots = layoutMode === "ring" ? placeRing(seats.length, width, tilesH) : placeGrid(seats.length, width, tilesH);
  placeSubtitle(words, inRing ? ringHole(spots, width, tilesH) : null, height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  seats.forEach((info, i) => {
    const spot = spots[i];
    info.where = {
      x: (spot.x + spot.w / 2 - width / 2) / (width / 2),
      y: (spot.y + spot.h / 2 - height / 2) / (height / 2),
    };
    Object.assign(info.tile.style, {
      left: Math.round(spot.x) + "px", top: Math.round(spot.y) + "px",
      width: Math.round(spot.w) + "px", height: Math.round(spot.h) + "px",
    });
    info.canvas.width = Math.round(spot.w * dpr);
    info.canvas.height = Math.round(spot.h * dpr);
  });
}

/* ---------------- the words ---------------- */

// a phrase's words are the first non-empty "text" a cue on that phrase
// gives the stage — which in cues.json is exactly one per phrase
const cues = await fetch("/scan/cues.json", { cache: "no-cache" })
  .then((r) => r.json())
  .catch(() => ({ cues: [] }));
const subtitleFor = (n) => {
  const cue = (cues.cues || []).find((c) => Number(c.phrase) === n && c.stage && c.stage.text);
  return cue ? cue.stage.text : "";
};
let wordsOn = true;

function placeSubtitle(text, hole, wallH) {
  const el = $("subtitle");
  el.classList.toggle("inring", !!hole);
  el.classList.toggle("gone", !text);
  el.textContent = text;
  for (const k of ["left", "top", "bottom", "width", "height"]) el.style[k] = "";
  // stage.html's clamp(30px, 6vh, 86px), as a share of this wall
  let size = wallH * 0.06;
  el.style.fontSize = size + "px";
  if (!hole) {
    el.style.bottom = wallH * 0.026 + "px";
    return;
  }
  Object.assign(el.style, {
    left: Math.round(hole.x) + "px", top: Math.round(hole.y) + "px",
    width: Math.round(hole.w) + "px", height: Math.round(hole.h) + "px",
  });
  // stage.js's fitSubtitle: give up size until the phrase fits the hole
  while (size > 8 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
    size -= 1;
    el.style.fontSize = size + "px";
  }
}

/* ---------------- the transport ---------------- */

let playing = true;
let at = 0;                    // seconds into the recording
let last = 0;

function draw() {
  requestAnimationFrame(draw);
  const now = performance.now();
  // the stage's own dt: real seconds, capped, so fades are durations
  const dt = Math.min(0.1, last ? (now - last) / 1000 : 1 / 60);
  last = now;
  if (playing) at = (at + dt) % LENGTH;
  const time = Date.now() / 1000;
  for (const info of seats) {
    info.frame = frames[(Math.floor(at * RATE) + info.offset) % frames.length];
    easeFrame(info, info.frame, look);
    drawWire(info.canvas.getContext("2d"), info.canvas, info, time, dt, look, aimFor(info));
  }
  paintState();
}

function paintState() {
  if (!scrubbing) $("scrub").value = String(at / LENGTH);
  const f = frames[Math.floor(at * RATE) % frames.length];
  $("state").innerHTML =
    at.toFixed(2) + "s / " + LENGTH.toFixed(1) + "s · first tile /" + (f.p || "·") + "/ " +
    (f.v === 0 ? '<span class="wh">whispered</span>' : "<b>voiced</b>");
}

let scrubbing = false;
$("scrub").addEventListener("pointerdown", () => (scrubbing = true));
$("scrub").addEventListener("pointerup", () => (scrubbing = false));
$("scrub").addEventListener("input", (e) => (at = Number(e.target.value) * LENGTH));
function togglePlay() {
  playing = !playing;
  $("play").textContent = playing ? "pause" : "play";
}
$("play").addEventListener("click", togglePlay);
$("seats").addEventListener("change", (e) => seat(Number(e.target.value)));
$("layout").addEventListener("change", (e) => {
  layoutMode = e.target.value;
  layout();
});
$("words").addEventListener("click", (e) => {
  wordsOn = !wordsOn;
  e.target.classList.toggle("on", wordsOn);
  layout();
});
$("labels").addEventListener("click", (e) => {
  e.target.classList.toggle("on", document.body.classList.toggle("labels"));
});
$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  if (root.dataset.theme === "dark") delete root.dataset.theme;
  else root.dataset.theme = "dark";
  // the surface modes cache a palette built from the colours
  for (const info of seats) { info.buf = null; info.bufRect = null; }
});
function togglePanel() {
  document.body.classList.toggle("nopanel");
  layout();
}
$("hide").addEventListener("click", togglePanel);
window.addEventListener("resize", layout);
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  if (e.key === "h") togglePanel();
});

/* ---------------- the panel ---------------- */

const fmt = (v, step) => {
  const places = String(step).includes(".") ? String(step).split(".")[1].length : 0;
  return Number(v).toFixed(places);
};
const knob = (name) => KNOBS.find((k) => k[0] === name);

/**
 * One slider and its number box. `get` returns undefined for a value that
 * is not set (an angle falling back to the look's own); `clear`, if there
 * is one, gives the row an × that unsets it.
 */
function row(parent, label, [, , min, max, step, note], get, set, was, clear) {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML =
    '<label></label><input type="range" /><input type="number" /><span class="x"></span>';
  const [lab, range, num, x] = el.children;
  lab.textContent = label;
  lab.title = note;
  for (const input of [range, num]) Object.assign(input, { min, max, step });
  const paint = () => {
    const v = get();
    const shown = v === undefined ? was.fallback() : v;
    range.value = String(shown);
    if (document.activeElement !== num) num.value = fmt(shown, step);
    el.classList.toggle("unset", v === undefined);
    el.classList.toggle("changed", v !== was.value());
    x.textContent = clear && v !== undefined ? "×" : "";
  };
  const take = (value) => {
    if (!isFinite(value)) return;
    set(value);
    sync();
  };
  range.addEventListener("input", () => take(Number(range.value)));
  num.addEventListener("change", () => take(Number(num.value)));
  if (clear) x.addEventListener("click", () => { clear(); sync(); });
  el.__paint = paint;
  parent.appendChild(el);
  paint();
  return el;
}

function buildPanel() {
  const sel = $("phrase");
  sel.textContent = "";
  for (let n = 1; n <= PHRASES; n++) sel.add(new Option(String(n), String(n)));
  sel.value = String(phrase);

  const surf = $("surface");
  surf.textContent = "";
  for (const s of SURFACES) surf.add(new Option(s, s));
  surf.value = look.surface;

  // the look: every knob, in look.js's order, against the file
  const knobs = $("knobs");
  knobs.textContent = "";
  for (const k of KNOBS) {
    const name = k[0];
    row(knobs, name.toLowerCase(), k, () => look[name], (v) => (look[name] = v), {
      value: () => fileState().look[name],
      fallback: () => fileState().look[name],
    });
  }

  const sp = $("spread");
  sp.textContent = "";
  for (const [key, max] of [["yaw", 1], ["pitch", 0.5]]) {
    row(sp, key, [key, 0, 0, max, 0.01, "the most a seat at the edge of the wall is pushed"],
      () => spread[key], (v) => (spread[key] = v),
      { value: () => fileState().spread[key], fallback: () => fileState().spread[key] });
  }
  paintAngles();
  sync();
}

function paintAngles() {
  const box = $("angles");
  if (!box) return;
  box.textContent = "";
  const fileAngles = (file && file.phrases && file.phrases[String(phrase)]) || {};
  PART_NAMES.forEach((name, i) => {
    const part = String(i + 1);
    const group = document.createElement("div");
    group.className = "part";
    group.innerHTML = "<span>part " + name + "</span>";
    box.appendChild(group);
    for (const KEY of ANGLES) {
      const key = KEY.toLowerCase();  // look.json writes angles in lower case
      const mine = () => (phrases[String(phrase)] || {})[part] || {};
      row(group, key, knob(KEY), () => mine()[key],
        (v) => {
          const p = (phrases[String(phrase)] ||= {});
          (p[part] ||= {})[key] = v;
        },
        {
          value: () => (fileAngles[part] || {})[key],
          // what an unset angle actually draws at, before the parallax
          fallback: () => look[KEY],
        },
        () => {
          const p = phrases[String(phrase)];
          if (!p || !p[part]) return;
          delete p[part][key];
          if (!Object.keys(p[part]).length) delete p[part];
          if (!Object.keys(p).length) delete phrases[String(phrase)];
        });
    }
  });

  // this phrase's own spread: unset falls back to the piece's
  const group = document.createElement("div");
  group.className = "part";
  group.innerHTML = "<span>spread, this phrase</span>";
  box.appendChild(group);
  const fileOwn = ((file && file.phrases && file.phrases[String(phrase)]) || {}).spread || {};
  for (const [key, max] of [["yaw", 1], ["pitch", 0.5]]) {
    const own = () => ((phrases[String(phrase)] || {}).spread || {});
    row(group, key, [key, 0, 0, max, 0.01, "this phrase's spread; unset uses the piece's, below"],
      () => own()[key],
      (v) => {
        const p = (phrases[String(phrase)] ||= {});
        (p.spread ||= {})[key] = v;
      },
      { value: () => fileOwn[key], fallback: () => spread[key] },
      () => {
        const p = phrases[String(phrase)];
        if (!p || !p.spread) return;
        delete p.spread[key];
        if (!Object.keys(p.spread).length) delete p.spread;
        if (!Object.keys(p).length) delete phrases[String(phrase)];
      });
  }
  paintPhraseNote();
}

function paintPhraseNote() {
  const note = $("phraseNote");
  if (unsaved(phrase))
    note.innerHTML = '<span class="warn">Nothing saved for phrase ' + phrase +
      ".</span> The desk shuffles a phrase like this, so the wall is shuffled — set any angle to save one.";
  else
    note.textContent = "Unset (dim) angles fall back to the look's own yaw, pitch and perspective." +
      (shuffle ? " Shuffled on top." : "");
  $("shuffle").classList.toggle("on", !!shuffle);
}

/** after any change: repaint every row, and the file */
let wasUnsaved = null;
function sync() {
  // a phrase that has just gained its first angle stops being shuffled,
  // the way it would arrive from the desk
  const now = unsaved(phrase);
  if (wasUnsaved === true && !now) shuffle = 0;
  wasUnsaved = now;
  for (const el of document.querySelectorAll(".row")) el.__paint();
  paintPhraseNote();
  $("out").value = fileText();
  const dirty = $("out").value !== fileText(fileState());
  $("status").textContent = dirty ? "changed" : "as saved";
  $("status").style.color = dirty ? "var(--tract)" : "";
}

/** phrases in order, parts in order, and nothing empty left behind */
function tidy(all) {
  const ordered = {};
  for (const n of Object.keys(all || {}).sort((a, b) => a - b)) {
    const parts = {};
    for (const p of Object.keys(all[n] || {}).filter((k) => k !== "spread").sort()) {
      const angles = {};
      for (const KEY of ANGLES) {
        const v = all[n][p][KEY.toLowerCase()];
        if (v !== undefined) angles[KEY.toLowerCase()] = v;
      }
      if (Object.keys(angles).length) parts[p] = angles;
    }
    const own = {};
    for (const key of ["yaw", "pitch"]) {
      const v = ((all[n] || {}).spread || {})[key];
      if (v !== undefined) own[key] = v;
    }
    if (Object.keys(own).length) parts.spread = own;
    if (Object.keys(parts).length) ordered[n] = parts;
  }
  return ordered;
}

const COMMENT =
  "How the wall draws. 'look' is settled in rehearsal; 'phrases' holds yaw, pitch and perspective per part per phrase, which are the only things worth moving during a performance. Written by the conductor's page.";

/** look.json as the desk writes it: same keys, same order, same comment */
function fileText(state = { look, spread, phrases }, comment = file && file._comment) {
  return JSON.stringify(
    { _comment: comment || COMMENT, look: state.look, spread: state.spread, phrases: tidy(state.phrases) },
    null,
    2
  ) + "\n";
}

/** the page's state as the file on disk has it, for "changed" */
const fileState = () => ({
  look: Object.assign(defaults(), (file && file.look) || {}),
  spread: Object.assign({ yaw: 0.22, pitch: 0.1 }, (file && file.spread) || {}),
  phrases: (file && file.phrases) || {},
});

/**
 * The look and the spread, which belong to the whole piece, and one
 * phrase's angles, into look.json. The file is read fresh from disk
 * first, so a hand edit to ANOTHER phrase made since this page loaded
 * survives; the look and spread are this page's and replace the file's. The bridge's own answer
 * is what counts, as on the desk: an old bridge with no PUT serves the
 * file back with a 200.
 */
async function writePhrase() {
  const n = String(phrase);
  const line = $("wrote");
  try {
    const disk = await (await fetch("/scan/look.json", { cache: "no-cache" })).json();
    const all = Object.assign({}, disk.phrases || {});
    const mine = tidy({ [n]: phrases[n] || {} })[n];
    if (mine) all[n] = mine;
    else delete all[n];
    disk.look = clone(look);
    disk.spread = clone(spread);
    disk.phrases = tidy(all);
    const response = await fetch("/scan/look.json", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(disk, null, 2) + "\n",
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.ok !== true) throw new Error("the bridge did not take it");
    // what is on disk now is the new baseline for the look, the spread
    // and this phrase; the other phrases are still compared with what
    // was loaded, since this page did not write them
    file.look = clone(look);
    file.spread = clone(spread);
    file.phrases = Object.assign({}, file.phrases || {});
    if (mine) file.phrases[n] = clone(mine);
    else delete file.phrases[n];
    line.textContent = "wrote the look and phrase " + n + (mine ? "" : " (no angles set, so removed)") + " to scan/look.json";
    paintAngles();
    sync();
  } catch (e) {
    line.textContent = "could not write look.json: " + e.message;
  }
}

$("phrase").addEventListener("change", (e) => {
  goToPhrase(Number(e.target.value));
  wasUnsaved = unsaved(phrase);
  sync();
});
$("surface").addEventListener("change", (e) => {
  look.surface = e.target.value;
  sync();
});
$("shuffle").addEventListener("click", () => { shuffle = freshSeed(); sync(); });
$("unshuffle").addEventListener("click", () => { shuffle = 0; sync(); });
$("reload").addEventListener("click", async () => { await load(); sync(); });
$("writePhrase").addEventListener("click", writePhrase);
$("copy").addEventListener("click", async (e) => {
  const text = fileText();
  console.log(text);
  try {
    await navigator.clipboard.writeText(text);
    e.target.textContent = "copied";
  } catch (err) {
    $("out").select();
    e.target.textContent = "select + copy below";
  }
  setTimeout(() => (e.target.textContent = "copy look.json"), 1600);
});

/* for the console, and for a test to check against */
window.tune = {
  BUILD,
  get text() {
    return fileText();
  },
  get words() {
    return $("subtitle").textContent;
  },
  ink() {
    return seats.map((info) => {
      const d = info.canvas.getContext("2d").getImageData(0, 0, info.canvas.width, info.canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
      return n;
    });
  },
};

seat(9);
await load();
wasUnsaved = unsaved(phrase);
sync();
requestAnimationFrame(draw);
console.log(`Tract tune build ${BUILD}`);
