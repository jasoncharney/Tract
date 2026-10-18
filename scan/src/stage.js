/*
  scan/src/stage.js — the projection.

  Every player streams the 44 tract diameters its own visualiser is drawing
  from (`/tract/frame`), and this page draws them all side by side for the
  audience. It makes no sound and has no synth: it is a window onto four to
  twelve vocal tracts, laid out to fill a 16:9 projector with as little wasted
  wall as possible.

  The drawing is upstream Pink Trombone's own geometry — same origin, radius,
  scale and angle sweep as `TractUI` — so what the room sees is the shape the
  player is playing, not an impression of it.
*/

const BUILD = "2026-10-15b";
const $ = (id) => document.getElementById(id);

/* ---- upstream's numbers, so the shape is the shape ---- */
const PT = {
  origin: { x: 340, y: 460 },
  radius: 298,
  scale: 60,
  angle: { scale: 0.64, offset: -0.25 },
  box: { w: 600, h: 500 },
};

const GONE_AFTER = 6000; // a player that has said nothing for this long leaves
const players = new Map(); // machine -> { part, at, frame, canvas, tile }
let ws = null;
let order = []; // machine ids, in the order they are drawn

/* ================================================================ *
 *  the wire
 * ================================================================ */

function send(address, args) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ address, args }));
}

function connectWS() {
  const port = location.port || (location.protocol === "https:" ? 443 : 80);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${port}/`;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    return;
  }
  ws.addEventListener("open", () => send("/stage/hello", [BUILD]));
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    (Array.isArray(message) ? message : [message]).forEach(take);
  });
  ws.addEventListener("close", () => {
    ws = null;
    setTimeout(connectWS, 1500);
  });
  ws.addEventListener("error", () => {});
}

// keep saying so: a player only streams while a stage is listening
setInterval(() => send("/stage/hello", [BUILD]), 2000);

function take(message) {
  if (!message) return;
  if (message.address === "/stage/set") {
    let block;
    try {
      block = JSON.parse(String((message.args || [])[0]));
    } catch (e) {
      return;
    }
    applyStage(block); // repeating a state it is already in is a no-op
    return;
  }
  // players still announce their phrase; the wall no longer reads anything
  // into it, but the debug overlay shows it
  if (message.address === "/tract/phrase") {
    const args = message.args || [];
    const machine = String(args[1] || "?");
    const info = players.get(machine);
    const phrase = { n: Number(args[2]) || 0, text: String(args[3] || "") };
    if (info) info.phrase = phrase;
    return;
  }
  if (message.address !== "/tract/frame") return;
  const args = message.args || [];
  const machine = String(args[1] || args[0] || "?");
  let frame;
  try {
    frame = JSON.parse(String(args[2]));
  } catch (e) {
    return;
  }
  if (!frame || !Array.isArray(frame.d)) return;
  const known = players.get(machine);
  if (known) {
    known.at = performance.now();
    known.part = String(args[0]);
    known.frame = frame;
  } else {
    players.set(machine, {
      part: String(args[0]),
      at: performance.now(),
      frame,
      tile: null,
      phrase: null,
    });
    layout();
  }
}

/* ================================================================ *
 *  what the wall is doing, and when
 *
 *  All of it comes from the cue sheet now. A cue in cues.json may carry a
 *  "stage" block beside its "parts" block:
 *
 *      "stage": {
 *        "title":  { "main": "Tract", "sub": "…", "by": "…" },  // or a string,
 *                                                              // or false to hide
 *        "tracts": true,            // fade the wall of tracts in, or out
 *        "text":   "words strain",  // the subtitle; "" clears it
 *        "fade":   2                // seconds, for everything in this block
 *      }
 *
 *  Every key is optional: a block that only says `"text"` changes only the
 *  words. Nothing here watches the players any more — the wall used to take a
 *  majority vote of everyone's current phrase, which meant the words changed
 *  when enough laptops happened to agree rather than when the conductor said
 *  so. `?subtitles=0` still silences the words for a run.
 * ================================================================ */

const SUBTITLES = new URLSearchParams(location.search).get("subtitles") !== "0";
let showing = "";

/**
 * What is actually in force, so that repeating a block is a no-op.
 *
 * The conductor sends the standing state on every heartbeat, which is how a
 * projector plugged in halfway through catches up. That only works if applying
 * the same state twice does nothing — otherwise every heartbeat would restart
 * the fades. So each key is compared against what is already showing, and only
 * the ones that differ are touched.
 */
const current = { title: undefined, tracts: undefined, text: undefined };

/** the three lines of the card, from a string or an object.
 *  `true` means "show it exactly as it is" — the conductor's button sends that,
 *  so putting the card back up does not need to restate its words. */
function setTitleText(title) {
  if (title === true) return;
  if (typeof title === "string") {
    $("titleMain").textContent = title;
    return;
  }
  if (!title || typeof title !== "object") return;
  if ("main" in title) $("titleMain").textContent = String(title.main);
  if ("sub" in title) $("titleSub").textContent = String(title.sub);
  if ("by" in title) $("titleBy").textContent = String(title.by);
}

function applyStage(block) {
  if (!block || typeof block !== "object") return;
  const card = $("titleCard");
  const wall = $("wall");
  const seconds = Math.max(0, Math.min(30, Number(block.fade ?? 2)));

  // work out what is actually changing before touching anything
  const wantTitle =
    "title" in block
      ? block.title === false || block.title === null || block.title === ""
        ? null // away
        : block.title // an object, a string, or `true` for "as it is"
      : undefined;
  const wantTracts = "tracts" in block ? !!block.tracts : undefined;
  const wantText = "text" in block ? String(block.text ?? "") : undefined;

  const titleChanged =
    wantTitle !== undefined && JSON.stringify(wantTitle) !== JSON.stringify(current.title);
  const tractsChanged = wantTracts !== undefined && wantTracts !== current.tracts;
  const textChanged = wantText !== undefined && wantText !== current.text;
  if (!titleChanged && !tractsChanged && !textChanged) return;

  document.documentElement.style.setProperty("--card-fade", `${seconds}s`);
  document.documentElement.style.setProperty("--wall-fade", `${seconds}s`);

  let hidingCard = false;
  if (titleChanged) {
    current.title = wantTitle;
    if (wantTitle === null) {
      hidingCard = !card.classList.contains("gone");
      card.classList.add("gone");
    } else {
      setTitleText(wantTitle);
      card.classList.remove("gone");
    }
  }

  if (tractsChanged) {
    current.tracts = wantTracts;
    // "fade to background, THEN bring the tracts up" — so when one cue does
    // both, the wall waits for the card to be gone rather than crossing it
    const light = () => wall.classList.toggle("lit", wantTracts);
    if (hidingCard && wantTracts) setTimeout(light, seconds * 1000);
    else light();
  }

  if (textChanged) {
    current.text = wantText;
    setSubtitle(wantText);
  }
  layout(); // the hint follows whether the card is up
}

/** the words along the bottom, and the strip of wall they cost */
function setSubtitle(text) {
  const el = $("subtitle");
  if (!el || !SUBTITLES) return;
  const next = text || "";
  if (next === showing) return;
  showing = next;
  // the wall gives up a strip for the words rather than drawing behind them
  // 6vh of type on 1.2 lines, plus the 2.6vh it sits off the floor and a
  // little air above: enough that a second line has somewhere to go
  document.documentElement.style.setProperty("--subs", next ? "15vh" : "0px");
  layout();
  // out, swap, in — so the words change with a breath rather than a jump cut
  el.classList.add("gone");
  setTimeout(
    () => {
      el.textContent = next;
      el.classList.toggle("gone", !next);
    },
    next ? 260 : 0
  );
}

/** drop anyone who has gone quiet, and keep the drawing order stable */
function reap() {
  const now = performance.now();
  let changed = false;
  players.forEach((info, machine) => {
    if (now - info.at > GONE_AFTER) {
      if (info.tile) info.tile.remove();
      players.delete(machine);
      changed = true;
    }
  });
  if (changed) layout();
}
setInterval(reap, 1000);

/* ================================================================ *
 *  filling the wall
 *
 *  Each tract wants a 600x500 box. Given N of them in a 16:9 screen, try every
 *  column count and keep whichever wastes the least: the one where the tile the
 *  grid allows is closest to the shape the drawing actually wants.
 * ================================================================ */

function bestGrid(count, width, height) {
  const want = PT.box.w / PT.box.h;
  let best = { cols: 1, rows: count, area: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const w = width / cols;
    const h = height / rows;
    // the drawing keeps its proportions inside the cell, so the used area is
    // whatever a 600x500 box can take of it
    const drawW = Math.min(w, h * want);
    const drawH = drawW / want;
    const area = drawW * drawH * count;
    if (area > best.area) best = { cols, rows, area };
  }
  return best;
}

/* ================================================================ *
 *  the ring
 *
 *  The grid is the safe shape — it gives every drawing the most room there
 *  is. The ring trades some of that for an arrangement that reads as an
 *  ensemble rather than a contact sheet, which for an odd number is often the
 *  better picture: nine in a grid is three tidy rows, nine in a ring is nine
 *  voices around a space.
 *
 *  It is an ellipse, not a circle, because a circle inscribed in a 16:9 wall
 *  throws away everything to the left and right of it. The tile size is found
 *  by relaxation rather than by trigonometry: place them, measure the closest
 *  pair, shrink to fit, repeat. Trigonometry would do for a true circle, but
 *  on an ellipse the tightest neighbours are not evenly spaced, and this way
 *  the same code is correct at any count and any shape of screen.
 * ================================================================ */

/** the centres for a given tile size — bigger tiles mean a tighter ellipse */
function ringCentres(count, width, height, s) {
  const rx = Math.max(1, (width - s) / 2);
  const ry = Math.max(1, (height - s) / 2);
  const out = [];
  for (let i = 0; i < count; i++) {
    // from the top, clockwise, so part I is where a listener looks first
    const a = -Math.PI / 2 + (2 * Math.PI * i) / count;
    out.push({ cx: width / 2 + rx * Math.cos(a), cy: height / 2 + ry * Math.sin(a) });
  }
  return out;
}

/**
 * Can tiles this big sit on the ring without touching?
 *
 * Two axis-aligned squares of side s miss each other when they are clear on
 * EITHER axis — side by side is fine, stacked is fine, and only both at once
 * is an overlap. The obvious test, "keep the centres s apart", is the wrong
 * one: it is too weak on the diagonal, where two squares s apart do overlap,
 * and much too strong everywhere else, which is why a first pass at this put
 * nine players in 146px boxes on a 1600x760 wall when they had room
 * for 191.
 *
 * Every pair, not just neighbours: on a wide ellipse the closest pair is not
 * always the next one round.
 */
function ringFits(count, width, height, s) {
  const c = ringCentres(count, width, height, s);
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const dx = Math.abs(c[i].cx - c[j].cx);
      const dy = Math.abs(c[i].cy - c[j].cy);
      if (Math.max(dx, dy) < s) return false;
    }
  }
  return true;
}

function placeRing(count, width, height) {
  if (count === 1) {
    const s = Math.min(width, height) * 0.82;
    return [{ x: (width - s) / 2, y: (height - s) / 2, w: s, h: s }];
  }
  // Making the tiles bigger also pulls the ellipse inwards, so "does it fit"
  // only ever goes from true to false as s grows — which is exactly what
  // bisection needs. Thirty halvings settle it to well under a pixel, and
  // unlike iterating towards a fixed point it cannot oscillate.
  let lo = 8;
  let hi = Math.min(width, height) * 0.9;
  for (let pass = 0; pass < 30; pass++) {
    const mid = (lo + hi) / 2;
    if (ringFits(count, width, height, mid)) lo = mid;
    else hi = mid;
  }
  const s = lo;
  return ringCentres(count, width, height, s).map((p) => ({
    x: p.cx - s / 2,
    y: p.cy - s / 2,
    w: s,
    h: s,
  }));
}

/** the grid: whichever column count wastes the least of the wall */
function placeGrid(count, width, height) {
  const { cols } = bestGrid(count, width, height);
  const rows = Math.ceil(count / cols);
  const cellW = width / cols;
  const cellH = height / rows;
  const out = [];
  for (let index = 0; index < count; index++) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    // the last row is centred if it is short, so a five-player grid is not
    // left-heavy on a wall
    const inRow = Math.min(cols, count - row * cols);
    const indent = ((cols - inRow) * cellW) / 2;
    out.push({ x: indent + col * cellW, y: row * cellH, w: cellW, h: cellH });
  }
  return out;
}

const LAYOUTS = ["grid", "ring"];
let layoutMode = (() => {
  const asked = new URLSearchParams(location.search).get("layout");
  if (LAYOUTS.includes(asked)) return asked;
  try {
    const kept = localStorage.getItem("tract.stagelayout");
    if (LAYOUTS.includes(kept)) return kept;
  } catch (e) {}
  return "grid";
})();

function setLayout(mode) {
  if (!LAYOUTS.includes(mode)) return;
  layoutMode = mode;
  try {
    localStorage.setItem("tract.stagelayout", mode);
  } catch (e) {}
  layout();
  paintWho();
}

/* L cycles it, so the shape can be settled in the room with the real number of
 * players on the wall rather than guessed at beforehand. */
document.addEventListener("keydown", (event) => {
  if (event.key === "l" || event.key === "L") {
    setLayout(LAYOUTS[(LAYOUTS.indexOf(layoutMode) + 1) % LAYOUTS.length]);
    stirCursor();
  }
});

function layout() {
  const wall = $("wall");
  order = [...players.keys()].sort((a, b) => {
    const pa = Number(players.get(a).part) || 99;
    const pb = Number(players.get(b).part) || 99;
    return pa - pb || (a < b ? -1 : 1); // by part, then stable by id
  });
  const hint = $("hint");
  // the hint is for an empty screen: not while the title card is up, and not
  // once there is something to look at
  const cardUp = !$("titleCard").classList.contains("gone");
  if (hint) hint.classList.toggle("gone", order.length > 0 || cardUp);
  if (!order.length) return;

  const width = wall.clientWidth;
  const height = wall.clientHeight;
  const spots =
    layoutMode === "ring"
      ? placeRing(order.length, width, height)
      : placeGrid(order.length, width, height);

  order.forEach((machine, index) => {
    const info = players.get(machine);
    if (!info.tile) {
      const tile = document.createElement("div");
      tile.className = "tile";
      const canvas = document.createElement("canvas");
      tile.appendChild(canvas);
      wall.appendChild(tile);
      info.tile = tile;
      info.canvas = canvas;
    }
    const spot = spots[index];
    info.tile.style.left = `${Math.round(spot.x)}px`;
    info.tile.style.top = `${Math.round(spot.y)}px`;
    info.tile.style.width = `${Math.round(spot.w)}px`;
    info.tile.style.height = `${Math.round(spot.h)}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    info.canvas.width = Math.round(spot.w * dpr);
    info.canvas.height = Math.round(spot.h * dpr);
  });
  paintWho();
}

window.addEventListener("resize", layout);

/* ================================================================ *
 *  the drawing
 * ================================================================ */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function angleAt(index, lipStart) {
  return PT.angle.offset + (index * PT.angle.scale * Math.PI) / (lipStart - 1);
}

/** upstream's wobble: the whole shape shivers with how loud the tract is */
function wobbleAt(index, length, amplitude, time) {
  return (amplitude * 0.03 * Math.sin(2 * index - 50 * time) * index) / length;
}

function pointAt(index, diameter, frame, time) {
  const length = frame.d.length;
  const wobble = wobbleAt(index, length, frame.a || 0, time);
  const angle = angleAt(index, frame.lip || length - 5) + wobble;
  const radius = PT.radius - PT.scale * diameter + 100 * wobble;
  return {
    x: PT.origin.x - radius * Math.cos(angle),
    y: PT.origin.y - radius * Math.sin(angle),
  };
}

/**
 * Where the drawing actually lands, this frame. Upstream's canvas is mostly
 * empty around the arc and a projector cannot afford empty, so the shape is
 * measured and fitted to the tile instead — and the fit is eased rather than
 * snapped, or every closure of the lips would jump the scale.
 */
function boundsOf(frame, mouth) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const lip = frame.lip || frame.d.length - 5;
  for (let i = 1; i <= mouth; i++) {
    for (const d of [0, frame.d[i]]) {
      const angle = angleAt(i, lip);
      const radius = PT.radius - PT.scale * d;
      const x = PT.origin.x - radius * Math.cos(angle);
      const y = PT.origin.y - radius * Math.sin(angle);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function easeBox(info, box) {
  if (!info.box) {
    info.box = Object.assign({}, box);
    return info.box;
  }
  const k = 0.08;
  info.box.x += (box.x - info.box.x) * k;
  info.box.y += (box.y - info.box.y) * k;
  info.box.w += (box.w - info.box.w) * k;
  info.box.h += (box.h - info.box.h) * k;
  return info.box;
}

function drawTract(ctx, canvas, info, time) {
  const frame = info.frame;
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const length = frame.d.length;
  const lip = frame.lip || length - 5;
  const mouth = Math.min(length - 1, lip);
  const box = easeBox(info, boundsOf(frame, mouth));
  const pad = 0.9; // a little air, so the lips are not against the tile edge
  const fit = Math.min(w / box.w, h / box.h) * pad;
  ctx.setTransform(
    fit,
    0,
    0,
    fit,
    (w - box.w * fit) / 2 - box.x * fit,
    (h - box.h * fit) / 2 - box.y * fit
  );

  /* One subpath, always. The second leg used to open with a moveTo of its own,
     which split the outline in two — and a fill closes each subpath on its own,
     so the tract came out as two chord-closed slivers instead of one band. */
  const trace = (diameterAt, from, to, start = false) => {
    const step = to >= from ? 1 : -1;
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      const p = pointAt(i, diameterAt(i), frame, time);
      if (start && i === from) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
  };

  ctx.lineCap = ctx.lineJoin = "round";
  const voiced = frame.v !== 0;
  const loud = Math.max(0, Math.min(1, frame.i || 0));

  // Upstream fills the air column against the page's own pale pink rather than
  // against a drawn backdrop, and so does this: the stage background is that
  // same colour, so the tract reads exactly as it does on a player's screen.
  // The sweep is only meaningful as far as the lips: upstream's angle scale is
  // keyed to `lip.start`, so the last few sections swing on past the mouth and
  // are simply clipped away by its fixed 600x500 canvas. This drawing is fitted
  // to its own bounds rather than to that canvas, so it stops at the lips
  // instead — same shape, no tail sweeping across the tile.
  ctx.beginPath();
  trace((i) => frame.d[i], 1, mouth, true);
  trace(() => 0, mouth, 1);
  ctx.closePath();
  ctx.fillStyle = css("--tract");
  ctx.globalAlpha = voiced ? 1 : 0.7;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 3 / fit + 2;
  ctx.strokeStyle = voiced ? css("--edge") : css("--dim");
  ctx.stroke();

  // a bead where the tract is widest — the tongue, brightening as it sounds
  let peak = 0;
  let peakAt = 0;
  for (let i = 8; i < Math.min(lip, length - 2); i++) {
    if (frame.d[i] > peak) {
      peak = frame.d[i];
      peakAt = i;
    }
  }
  if (peak > 0.1) {
    const p = pointAt(peakAt, peak * 0.5, frame, time);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9 + 14 * loud, 0, Math.PI * 2);
    ctx.fillStyle = css("--bead");
    ctx.globalAlpha = voiced ? 0.55 + 0.45 * loud : 0.25;
    ctx.fill();
    ctx.globalAlpha = voiced ? 0.9 : 0.3;
    ctx.lineWidth = 2 / fit + 1;
    ctx.strokeStyle = css("--bg"); // a hairline of background, so it detaches
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawPhoneme(ctx, canvas, info, { fit, box, voiced });
}

/**
 * The phoneme being spoken, written in the crook of the throat.
 *
 * In slashes, because that is what the notation means: /ɑ/ is a sound, "ah"
 * is a spelling, and the whole piece is about the difference. It also stops a
 * one-letter phoneme reading as a word or an initial.
 *
 * Where it goes is derived rather than eyeballed. Every point of the shape
 * sits on an arc about PT.origin, so the origin IS the middle of the hollow —
 * the concave side of the bend, by construction, at any width the tract
 * takes. The band only ever lies between radius PT.radius and
 * PT.radius - PT.scale*d, so the centre is the one place it can never reach.
 * The small push outward along the middle of the sweep is for the widest
 * vowels, where the inner edge comes closest to the centre.
 */
/* How far into the pocket to sit, as a fraction of the room there is. At the
 * centre the type is safest but reads as floating near the corner of the tile
 * rather than tucked into the bend; this walks it back toward the curve and
 * leaves the rest of the gap as clearance. */
const CROOK_IN = 0.42;

function drawPhoneme(ctx, canvas, info, { fit, box, voiced }) {
  const frame = info.frame;
  const ipa = String(frame.p || "");
  if (!ipa) return;
  const length = frame.d.length;
  const lip = frame.lip || length - 5;
  const mouth = Math.min(length - 1, lip);
  const midIndex = Math.round((1 + mouth) / 2);
  const mid = angleAt(midIndex, lip);
  // The band lies between PT.radius and PT.radius - PT.scale*d, measured from
  // the origin, so the room in the pocket along this ray is the inner radius
  // right here — which shrinks as the vowel opens. Taking a fixed fraction of
  // it means a wide open /ɑ/ keeps the same proportion of clearance that a
  // closed stop does, instead of the type drifting into the pink.
  // Eased, like the fit box above and for the same reason: the tongue moves
  // every frame, so an anchor read straight off this frame's width would make
  // the label twitch and resize continuously through a sweep. It drifts to
  // where the shape is going instead.
  const want = Math.max(40, PT.radius - PT.scale * (frame.d[midIndex] || 0));
  info.room = info.room === undefined ? want : info.room + (want - info.room) * 0.06;
  const room = info.room;
  const px = PT.origin.x - CROOK_IN * room * Math.cos(mid);
  const py = PT.origin.y - CROOK_IN * room * Math.sin(mid);

  // out of the shape's coordinates and into the canvas's, so the type is drawn
  // at a real pixel size rather than scaled up from a 600x500 drawing
  const ox = (canvas.width - box.w * fit) / 2 - box.x * fit;
  const oy = (canvas.height - box.h * fit) / 2 - box.y * fit;
  const x = px * fit + ox;
  const y = py * fit + oy;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // and the type gives way if the pocket is ever tight: the clearance left
  // along the ray caps how big it is allowed to be. Measured across all 112
  // cells of all eight phrases, the middle of the tract never passes d = 1.30,
  // which leaves room ≈ 220 and never triggers this — it is a guard against a
  // shape the piece does not currently make, not something you will see.
  const clear = (1 - CROOK_IN) * room * fit;
  const size = Math.max(11, Math.min(Math.min(canvas.width, canvas.height) * 0.17, clear * 0.78));
  ctx.font = `${size}px ${css("--ipa-font") || "Gentium Plus, Charis SIL, Doulos SIL, serif"}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const text = `/${ipa}/`;
  // a breath of background behind it, so it holds up over the pink if a wide
  // vowel ever swings close
  ctx.lineWidth = Math.max(2, size * 0.14);
  ctx.strokeStyle = css("--bg");
  ctx.globalAlpha = 0.85;
  ctx.strokeText(text, x, y);
  ctx.globalAlpha = voiced ? 1 : 0.55;
  ctx.fillStyle = css("--ipa") || css("--edge");
  ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
}

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

/**
 * Who is actually feeding this wall.
 *
 * "I can see eight and I have nine players" has two quite different causes —
 * the wall could not place the ninth, or the ninth never reached the wall —
 * and from the back of a room they look identical. So the count is always
 * available and never in the way: it appears when the mouse moves and goes
 * with the cursor a couple of seconds later, which during a performance means
 * never. `?debug=1` pins it open and lists every machine.
 */
function paintWho() {
  const el = $("who");
  if (!el) return;
  const hushed = document.body.classList.contains("hushed");
  el.hidden = !DEBUG && hushed;
  if (el.hidden) return;
  const count = order.length;
  const head = `${count} ${count === 1 ? "player" : "players"} · ${layoutMode}${
    count ? "" : " · nobody feeding this wall"
  }`;
  if (!DEBUG) {
    el.textContent = `${head}\nL changes the layout`;
    return;
  }
  const rows = order.map((machine) => {
    const info = players.get(machine);
    return `  part ${info.part}  ${machine}  ${Math.round(performance.now() - info.at)} ms`;
  });
  el.textContent = [head, ...rows].join("\n");
}
setInterval(paintWho, 500);

function frame() {
  requestAnimationFrame(frame);
  const time = Date.now() / 1000;
  // if the tiles and the players ever disagree — a layout missed, a tile
  // removed by hand — put it right rather than drawing into the wrong boxes
  if (document.querySelectorAll(".tile").length !== order.length) layout();
  order.forEach((machine) => {
    const info = players.get(machine);
    if (!info || !info.canvas || !info.frame) return;
    const ctx = info.canvas.getContext("2d");
    drawTract(ctx, info.canvas, info, time);
  });
}
requestAnimationFrame(frame);

/* ================================================================ *
 *  the room
 * ================================================================ */

document.addEventListener("click", () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "f") document.documentElement.requestFullscreen?.();
  if (event.key === "Escape" && document.fullscreenElement) document.exitFullscreen?.();
});

// the cursor goes away on its own, and comes back if you move it
let hush = null;
function stirCursor() {
  document.body.classList.remove("hushed");
  clearTimeout(hush);
  hush = setTimeout(() => {
    document.body.classList.add("hushed");
    paintWho(); // and the count goes with the cursor, in the same breath
  }, 2500);
  paintWho(); // not on the next half-second tick: you moved the mouse to look
}
document.addEventListener("mousemove", stirCursor);
stirCursor();

window.stage = {
  BUILD,
  take, // the wire's entry point, so a test can fill the wall without 9 laptops
  setLayout,
  drawTract, // so a test can measure where the type lands, in pixels
  placeRing,
  placeGrid,
  get layout_mode() {
    return layoutMode;
  },
  get players() {
    return [...players.entries()].map(([machine, info]) => ({
      machine,
      part: info.part,
      sections: info.frame ? info.frame.d.length : 0,
      age: Math.round(performance.now() - info.at),
    }));
  },
  /* what each player is actually sending, for checking a feed at soundcheck */
  get frames() {
    return [...players.entries()].map(([machine, info]) => ({
      machine,
      part: info.part,
      phoneme: info.frame ? info.frame.p : undefined,
      widest: info.frame ? Math.max(...info.frame.d) : 0,
      middle: info.frame
        ? info.frame.d[Math.round((1 + Math.min(info.frame.d.length - 1, info.frame.lip || 39)) / 2)]
        : 0,
    }));
  },
  get grid() {
    const wall = $("wall");
    return bestGrid(players.size || 1, wall.clientWidth, wall.clientHeight);
  },
  layout,
};

connectWS();
console.log(`Tract stage build ${BUILD}`);
