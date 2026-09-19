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

const BUILD = "2026-09-18d";
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
  if (!message || message.address !== "/tract/frame") return;
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
    players.set(machine, { part: String(args[0]), at: performance.now(), frame, tile: null });
    layout();
  }
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

function layout() {
  const wall = $("wall");
  order = [...players.keys()].sort((a, b) => {
    const pa = Number(players.get(a).part) || 99;
    const pb = Number(players.get(b).part) || 99;
    return pa - pb || (a < b ? -1 : 1); // by part, then stable by id
  });
  const hint = $("hint");
  if (hint) hint.classList.toggle("gone", order.length > 0);
  if (!order.length) return;

  const width = wall.clientWidth;
  const height = wall.clientHeight;
  const { cols, rows } = bestGrid(order.length, width, height);
  const cellW = width / cols;
  const cellH = height / rows;

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
    const col = index % cols;
    const row = Math.floor(index / cols);
    // the last row is centred if it is short, so a five-player grid is not
    // left-heavy on a wall
    const inRow = Math.min(cols, order.length - row * cols);
    const indent = ((cols - inRow) * cellW) / 2;
    const x = indent + col * cellW;
    const y = row * cellH;
    info.tile.style.left = `${Math.round(x)}px`;
    info.tile.style.top = `${Math.round(y)}px`;
    info.tile.style.width = `${Math.round(cellW)}px`;
    info.tile.style.height = `${Math.round(cellH)}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    info.canvas.width = Math.round(cellW * dpr);
    info.canvas.height = Math.round(cellH * dpr);
  });
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
}

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

function paintWho() {
  const el = $("who");
  if (!el) return;
  el.hidden = !DEBUG;
  if (!DEBUG) return;
  const rows = order.map((machine) => {
    const info = players.get(machine);
    return `part ${info.part}  ${machine}  ${Math.round(performance.now() - info.at)} ms`;
  });
  el.textContent = rows.length ? rows.join("\n") : "nobody feeding";
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
  hush = setTimeout(() => document.body.classList.add("hushed"), 2500);
}
document.addEventListener("mousemove", stirCursor);
stirCursor();

window.stage = {
  BUILD,
  get players() {
    return [...players.entries()].map(([machine, info]) => ({
      machine,
      part: info.part,
      sections: info.frame ? info.frame.d.length : 0,
      age: Math.round(performance.now() - info.at),
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
