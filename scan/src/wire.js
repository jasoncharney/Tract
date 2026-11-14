/*
  scan/src/wire.js — the second drawing: a tract you can see the inside of.

  The wall's original drawing is a ribbon: a section through the tract, flat
  on the screen. This one stands the same numbers up in space. Pink Trombone's
  diameter array IS a bore, so the shape being drawn here is the thing itself
  rather than a picture of it, seen from an angle the conductor chooses.

  Three ways to draw it, all the same geometry:

    lines   ribs across the tongue and the long edges of its groove
    filled  the tongue as a solid with thickness and a rounded rim
    closed  floor and roof stitched into one skin — the volume as a wireframe

  What governs the whole thing: nothing is drawn for being there. Every
  section of every tract carries a heat that movement raises and time lets go
  of, so a part holding still fades back and a part articulating flares
  exactly where the work is being done. Loudness counts as movement too, or a
  piece made largely of held tones would be a dark wall.

  Each player owns its own state — the eased shape, the heat, the camera, the
  fitted box, the phoneme's little machine — hung on the record the stage
  already keeps for them. Nothing here is shared between tiles.
*/

import { SURFACES } from "./look.js";
import { PT, angleAt, wobbleAt, easeBox } from "./geom.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/*
  The look, for the length of one tile's draw.

  surf(), crossSection() and the rest read it the way the page this came from
  read its own panel — as something simply there. Threading it through six
  signatures would say nothing except that it is threaded; it is set once at
  the top of each draw instead, and every tile is drawn to completion before
  the next begins, so there is never a second look in play.
*/
let look = null;

/**
 * Ease the arriving frame rather than drawing it raw. The feed is twenty a
 * second and a phrase holds each phoneme for the best part of a second, so
 * drawn as it lands it reads as a slide show of poses. The voicing eases more
 * slowly than the shape, because it is a state rather than a movement.
 */
export function easeFrame(info, frame, theLook) {
  look = theLook;
  let shown = info.shown;
  if (!shown || shown.d.length !== frame.d.length) {
    info.shown = {
      d: frame.d.slice(),
      a: frame.a,
      i: frame.i,
      v: frame.v,
      lip: frame.lip,
      blade: frame.blade,
      ti: frame.ti,
      td: frame.td,
      p: frame.p,
    };
    return info.shown;
  }
  const k = look.EASE;
  for (let i = 0; i < frame.d.length; i++) shown.d[i] += (frame.d[i] - shown.d[i]) * k;
  shown.a += ((frame.a || 0) - shown.a) * k;
  shown.i += ((frame.i || 0) - shown.i) * k;
  shown.v += ((frame.v === undefined ? 1 : frame.v) - shown.v) * (k * 0.6);
  shown.lip = frame.lip;
  shown.blade = frame.blade;
  shown.p = frame.p;
  shown.ti = shown.ti === undefined ? frame.ti : shown.ti + ((frame.ti || 0) - shown.ti) * k;
  shown.td = shown.td === undefined ? frame.td : shown.td + ((frame.td || 0) - shown.td) * k;
  return shown;
}

function project(p, cam) {
  // yaw about the vertical, then pitch, then a gentle perspective
  const x = p.x - PT.origin.x, y = p.y - PT.origin.y, z = p.z;
  const cx = Math.cos(cam.yaw), sx = Math.sin(cam.yaw);
  const x1 = x * cx - z * sx, z1 = x * sx + z * cx;
  const cy2 = Math.cos(cam.pitch), sy2 = Math.sin(cam.pitch);
  const y1 = y * cy2 - z1 * sy2, z2 = y * sy2 + z1 * cy2;
  const k = cam.persp / (cam.persp + z2);
  // cx/cy/cz are the point before the perspective divide: the divide
  // bends straight lines, so a normal taken after it is not the
  // surface's normal, and shading from it ripples
  return { x: x1 * k, y: y1 * k, depth: z2, cx: x1, cy: y1, cz: z2 };
}

/* ----------------------------------------------------------------
 *  the drawing proposed: two surfaces, not a tube
 *
 *  A pipe drawn as a pipe is a pipe — a worm. But the bore is only the
 *  GAP between two things: a roof that never moves, and a tongue that
 *  does nothing but. So draw those two and let the bore be the space
 *  left over. The tongue is a sheet of fixed width rather than a
 *  cross-section of the bore, which is what keeps it a plane and not a
 *  tube wall, and it is where every articulation in the piece actually
 *  happens.
 *
 *  Nothing is drawn for being there. Lines earn their opacity by
 *  moving: each section carries a heat that a change raises and time
 *  lets go of, so a still tract is a ghost and an articulating one
 *  flares exactly where the work is being done.
 * ---------------------------------------------------------------- */
/* the numbers below all come from K, at the top — see the panel */

function stoke(info, frame, dt) {
  // the page this came from built these up front; here a player's record is
  // made by the stage long before it knows which drawing it will get
  const heat = info.heat || (info.heat = []);
  const len = frame.d.length;
  if (!info.drawn) { info.drawn = frame.d.slice(); for (let i = 0; i < len; i++) heat[i] = 0; return; }
  /*
    Articulation is not the only kind of movement. A held tone is a
    mouth doing nothing and a tract shivering with its own loudness —
    upstream's wobble, weighted toward the lips — and a drawing that
    went dark through every held note would be dark through most of
    this piece. So loudness keeps a floor under the heat, in the same
    place along the tract that the wobble puts it.
  */
  const amp = Math.max(0, Math.min(1, frame.a || 0));
  /*
    The decay is a time, not a factor per frame. It used to be the
    latter, which meant the same setting faded faster on a machine
    drawing more frames — and that eight tiles, which draw slower than
    one, held their light LONGER than the single view beside them. A
    second is a second.
  */
  const fade = Math.exp(-dt / Math.max(0.01, look.HOLD));
  for (let i = 0; i < len; i++) {
    const moved = Math.abs(frame.d[i] - info.drawn[i]) * look.GAIN;
    const breath = amp * look.SHIMMER * (i / len);
    heat[i] = Math.min(1, Math.max(heat[i] * fade, moved, breath));
    info.drawn[i] = frame.d[i];
  }
}

/*
  The bore between sections, as a curve rather than a step.

  Catmull-Rom through the four nearest sections: it passes through the
  data rather than near it, which matters because the sections ARE the
  measurement — a smoothing that pulled away from them would be drawing
  a different tract. Sampling between them is the whole of the
  smoothing; there is no surface being approximated, only this curve
  swept across the width, where the dish is analytic anyway.
*/
function dAt(frame, x) {
  const d = frame.d, n = d.length;
  const i = Math.floor(x), f = x - i;
  if (f === 0) return d[Math.max(0, Math.min(n - 1, i))] || 0;
  const at = (j) => d[Math.max(0, Math.min(n - 1, j))] || 0;
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  return (
    0.5 *
    ((2 * p1) +
      (-p0 + p2) * f +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
      (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f)
  );
}

/* a point on either surface: u runs -1..1 across the width */
function surf(i, frame, time, floor, u, dr, dz) {
  const len = frame.d.length;
  /* Upstream's shiver is a couple of units in a 600-unit drawing, but this
     one is fitted to the mouth alone, so it lands as a wave rolling down the
     tongue eight times a second — on a held note, the shape re-forming into
     itself. Measured on a held /ɚ/ at a 1200px tile: 14,300 pixels changing
     every frame with the loudness held steady, none with it at zero. The
     heat reads loudness on its own, so taking this down does not darken a
     held note. */
  const w = wobbleAt(i, len, (frame.a || 0) * look.WOBBLE, time, look.WOBHZ * 2 * Math.PI);
  const a = angleAt(i, frame.lip || len - 5) + w;
  // the roof is where upstream puts the outer wall and never moves; the
  // floor is as far below it as the bore is wide
  const dish = floor ? look.GROOVE * (1 - u * u) : 0;
  const r = floor
    ? PT.radius - PT.scale * dAt(frame, i) + dish + (dr || 0) + 100 * w
    : PT.radius + 100 * w;
  return {
    x: PT.origin.x - r * Math.cos(a),
    y: PT.origin.y - r * Math.sin(a),
    z: u * look.SHEET + (dz || 0),
  };
}

/*
  The cross-section of the tongue, as a closed loop: across the top from
  one edge to the other, round the rim, back along the underside, round
  the other rim. The rim is three points on a half-circle, which is all
  it takes to stop an edge reading as a cut.

  This is what gives it thickness without a second surface's worth of
  detail — the underside is the same curve moved, and the rim is a
  handful of points per section rather than a grid.
*/
function crossSection(us, thick) {
  const out = us.map((u) => ({ u, dr: 0, dz: 0 }));
  if (thick < 1) return { pts: out, closed: false };
  const h = thick / 2;
  for (const th of [Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4])
    out.push({ u: 1, dr: -h * (1 - Math.cos(th)), dz: h * Math.sin(th) });
  for (let k = us.length - 1; k >= 0; k--) out.push({ u: us[k], dr: -thick, dz: 0 });
  for (const th of [(3 * Math.PI) / 4, Math.PI / 2, Math.PI / 4])
    out.push({ u: -1, dr: -h * (1 - Math.cos(th)), dz: -h * Math.sin(th) });
  return { pts: out, closed: true };
}

export function drawWire(ctx, canvas, info, time, dt, theLook, aim) {
  look = theLook;
  const frame = info.shown;
  if (!frame || !frame.d) return;
  const mode = Math.max(0, SURFACES.indexOf(look.surface || "lines"));
  const heat = info.heat || (info.heat = []);
  const w = canvas.width, h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const len = frame.d.length;
  const lip = frame.lip || len - 5;
  const mouth = Math.min(len - 1, lip);
  const blade = Math.max(1, frame.blade || 9);
  const voiced = Math.max(0, Math.min(1, frame.v === undefined ? 1 : frame.v));
  const loud = Math.max(0, Math.min(1, frame.i || 0));
  /*
    The tract itself no longer thins when the part whispers. It used to
    drop to about four tenths, which on a projector is the difference
    between legible and not, for a state the audience cannot hear as
    "quieter" anyway — a whisper is a different sound, not a softer one.
    The phoneme carries it instead: solid when voiced, an outline when
    whispered. One thing changes, and it is the thing you are reading.
  */
  const sheer = 1;

  stoke(info, frame, dt);

  /*
    Each view carries its own camera, and it is never set, only eased
    toward. Its target is the pair of sliders plus this view's own
    offset — nought for everybody until the shuffle hands them one —
    so moving yaw or pitch still swings the whole wall together and
    keeps whatever spread the shuffle gave it.
  */
  const cam = info.cam || (info.cam = { yaw: aim.yaw, pitch: aim.pitch, persp: aim.perspective });
  cam.yaw += (aim.yaw - cam.yaw) * look.CAMEASE;
  cam.pitch += (aim.pitch - cam.pitch) * look.CAMEASE;
  cam.persp += (aim.perspective - cam.persp) * look.CAMEASE;

  /*
    Where to sample. In lines mode the control grid IS the drawing — one
    rib per section — so it samples at the sections and nowhere else.
    The two surface modes sample between them, SMOOTH times per section
    along the length and the same across the width, which is what takes
    the facets out.
  */
  const sub = mode === 0 ? 1 : Math.max(1, Math.round(look.SMOOTH));
  const xs = [];
  for (let q = 0; q <= (mouth - 1) * sub; q++) xs.push(1 + q / sub);
  const nu = mode === 0 ? look.RIBS : (look.RIBS - 1) * sub + 1;
  const us = [];
  for (let k = 0; k < nu; k++) us.push(-1 + (2 * k) / (nu - 1));
  const mid = (nu - 1) / 2 | 0;

  const floorPts = [], roofPts = [], hs = [];
  const heatAt = (x) => {
    const i = Math.floor(x), f = x - i;
    const a = heat[i] || 0, b = heat[Math.min(len - 1, i + 1)] || 0;
    return a + (b - a) * f;
  };
  for (let j = 0; j < xs.length; j++) {
    const x = xs[j];
    floorPts[j] = us.map((u) => project(surf(x, frame, time, true, u, 0, 0), cam));
    roofPts[j] = us.map((u) => project(surf(x, frame, time, false, u, 0, 0), cam));
    hs[j] = heatAt(x);
  }
  let bladeJ = xs.findIndex((x) => x >= blade);
  if (bladeJ < 0) bladeJ = 0;
  const last = xs.length - 1;

  /*
    Where the glyph wants to sit, worked out before the frame is fitted
    so the frame can make room for it. Clamping it afterwards put it
    hard against the top of the tile at most angles — which on a wall
    with no rules between the tiles reads as belonging to the tract
    above. Better to give up a little size and keep it beside its own
    mouth.
  */
  let glyph = null;
  const lingering = info.ipa && info.ipa.on > 0.01;
  if (look.IPA > 0 && (frame.p || lingering)) {
    /*
      The anchor is worked out on a tract with the wobble taken out.

      The wobble is upstream's shiver — it scales with loudness and is
      strongest at the lips, which is exactly where the glyph lives, so
      the letter was dancing several times a second while the mouth it
      belongs to was barely moving. Taking the amplitude to zero for
      these three points removes the shake at its source rather than
      smoothing it away afterwards, so the glyph still follows the
      articulation at full speed and ignores only the shiver.
    */
    const calm = Object.assign({}, frame, { a: 0 });
    const atX = xs[last];
    const backX = xs[Math.max(0, last - Math.round(3 * sub))];
    const a2 = project(surf(atX, calm, time, true, us[mid], 0, 0), cam);
    const b2 = project(surf(atX, calm, time, false, us[mid], 0, 0), cam);
    const back = project(surf(backX, calm, time, true, us[mid], 0, 0), cam);
    const mx = (a2.x + b2.x) / 2, my = (a2.y + b2.y) / 2;
    let ox = mx - back.x, oy = my - back.y;
    const oL = Math.hypot(ox, oy) || 1;
    // just clear of the lips, not launched from them
    const reach = Math.hypot(a2.x - b2.x, a2.y - b2.y) * 0.45 + 8;
    const want = { x: mx + (ox / oL) * reach, y: my + (oy / oL) * reach };
    // and then eased, for whatever is left: a camera swinging round, a
    // mouth opening fast, the jump when the playhead is dragged
    const g = info.gl || (info.gl = { x: want.x, y: want.y });
    g.x += (want.x - g.x) * look.IPAEASE;
    g.y += (want.y - g.y) * look.IPAEASE;
    glyph = g;
  } else {
    info.gl = null;
    info.ipa = null;   // long gone: the next one starts where it belongs
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let near = Infinity, far = -Infinity;
  /*
    The frame is set on the oral cavity, not on the whole tract. The
    throat is a single line running down to the glottis, and counting it
    cost about half of every tile to hold a thin line nobody is looking
    at. It still draws; it simply runs out of the picture, which is
    what a thing coming from off-stage should do. On a wall of nine
    that is the difference between tracts you can read across a room
    and tracts sitting in the corner of their own square.
  */
  for (let j = bladeJ; j <= last; j++) {
    for (const p of floorPts[j].concat(roofPts[j])) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.depth < near) near = p.depth; if (p.depth > far) far = p.depth;
    }
  }
  if (glyph) {
    // a letter's worth of room around it, in the units the shape is in
    const pad2 = Math.max(8, (maxY - minY) * look.IPA * 1.35);
    if (glyph.x - pad2 < minX) minX = glyph.x - pad2;
    if (glyph.x + pad2 > maxX) maxX = glyph.x + pad2;
    if (glyph.y - pad2 < minY) minY = glyph.y - pad2;
    if (glyph.y + pad2 > maxY) maxY = glyph.y + pad2;
  }
  const box = easeBox(info, { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) });
  const fit = Math.min(w / box.w, h / box.h) * 0.88;
  const tx0 = (w - box.w * fit) / 2 - box.x * fit;
  const ty0 = (h - box.h * fit) / 2 - box.y * fit;
  ctx.setTransform(fit, 0, 0, fit, tx0, ty0);
  ctx.lineCap = ctx.lineJoin = "round";

  const span = Math.max(1, far - near);
  const lift = (d) => 1 - (d - near) / span;   // 1 near, 0 far
  const body = css("--tract");
  const edge = css("--edge");
  const dim = css("--dim");
  const seg = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };

  /*
    A line that stops moving must not stop existing.

    The fade can be spent on opacity, on weight, or on a mixture, and
    BYWIDTH says how much of it goes to the weight. At 1 the opacity
    never drops at all and a quiet line is simply a thin one, which is
    what keeps a tract that has been holding for a while from
    disappearing off the wall. At 0 it is as it was: it fades to
    nothing. Weight reads at a distance in a way that opacity does not —
    a projector in a lit room loses a 15% line long before it loses a
    thin one.
  */
  const litOf = (live, floor) => Math.min(1, look.GHOST * floor + (1 - look.GHOST * floor) * live);
  const aOf = (lit) => lit + (1 - lit) * look.BYWIDTH;
  const wOf = (lit) => 1 - look.BYWIDTH + look.BYWIDTH * (0.18 + 1.82 * lit);

  /*
    Closed: the floor and the roof are stitched into one ring at every
    section — across the tongue, up the near wall, back along the roof,
    down the far wall — and the rings are joined down their length. It
    is a tube again, which is what it was before all this, but a tube
    whose lines still have to earn their opacity by moving, so what you
    get is a skin that only exists where the mouth is working.
  */
  if (mode === 2) {
    const ringOf = (j) => floorPts[j].concat(roofPts[j].slice().reverse());
    const N = nu * 2;
    for (let j = bladeJ; j <= last; j++) {
      const live = hs[j];
      const r = ringOf(j);
      const lit = litOf(live, 0.7);
      ctx.lineWidth = ((0.7 + 1.5 * live) * wOf(lit) * look.RIBW) / fit;
      for (let k = 0; k < N; k++) {
        const a = r[k], b = r[(k + 1) % N];
        const t = lift((a.depth + b.depth) / 2);
        ctx.globalAlpha = sheer * aOf(lit) * (0.3 + 0.7 * t);
        ctx.strokeStyle = live > 0.55 && t > 0.6 ? edge : body;
        seg(a, b);
      }
    }
    for (let j = bladeJ; j < last; j++) {
      const live = Math.max(hs[j], hs[j + 1]);
      const A = ringOf(j), B = ringOf(j + 1);
      const lit = litOf(live, 0.5);
      ctx.lineWidth = ((0.6 + 1.3 * live) * wOf(lit) * look.EDGEW) / fit;
      for (let k = 0; k < N; k++) {
        const t = lift((A[k].depth + B[k].depth) / 2);
        ctx.globalAlpha = sheer * aOf(lit) * (0.25 + 0.75 * t);
        ctx.strokeStyle = body;
        seg(A[k], B[k]);
      }
    }
  }

  // 1. the roof: a ceiling of three unlit lines, the only fixed thing
  //    in the picture, and only over the stretch the tongue is under
  if (mode !== 2) {
  ctx.strokeStyle = dim;
  for (const k of [0, mid, nu - 1]) {
    ctx.globalAlpha = sheer * (k === mid ? 0.34 : 0.22);
    ctx.lineWidth = 1.1 / fit;
    ctx.beginPath();
    for (let j = bladeJ; j <= last; j++) {
      const p = roofPts[j][k];
      if (j === bladeJ) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  }

  // 2. the whole length of the floor, a ghost that brightens where it
  //    moves. It runs the whole tract in both modes: the closed mesh
  //    covers only the oral cavity, and without this the throat would
  //    simply stop existing.
  // ...except across the tongue itself when the tongue is a surface:
  // there it is a seam drawn down the middle of a solid thing
  const ghostTo = mode === 1 ? Math.min(last, bladeJ) : last;
  for (let j = 0; j < ghostTo; j++) {
    const t = lift((floorPts[j][mid].depth + floorPts[j + 1][mid].depth) / 2);
    const live = Math.max(hs[j], hs[j + 1]);
    const lit = litOf(live, 1);
    ctx.globalAlpha = sheer * aOf(lit) * (0.45 + 0.55 * t);
    ctx.strokeStyle = live > 0.5 ? edge : body;
    ctx.lineWidth = ((0.9 + 1.8 * live) * wOf(lit) * look.GHOSTW) / fit;
    seg(floorPts[j][mid], floorPts[j + 1][mid]);
  }

  // 3. the sheet itself, over the stretch the tongue is the floor of:
  //    ribs across it, and its two long edges
  if (mode !== 2) {
  if (mode === 1) {
    /*
      The tongue as a solid.

      Shading used to come from each patch's screen AREA, on the idea
      that a patch turned away covers less of the screen. That works at
      four patches across and falls apart as you subdivide: neighbouring
      patches differ by a little for reasons that have nothing to do
      with facing — where they sit in the perspective, mostly — and the
      surface breaks out in ripples that crawl as the camera moves. The
      normalisation was per frame as well, so the whole thing breathed.

      So each patch is shaded by its actual normal, taken in camera
      space BEFORE the perspective divide (the divide bends straight
      lines, and a normal measured after it is not the surface's). A
      patch square-on to you is bright, one edge-on is dark, and that is
      all — no ripple, nothing that depends on the frame it is in.

      The same normal pays for the thickness: patches facing away are
      not drawn at all, so a closed slab costs about what the open sheet
      did.
    */
    const sec = crossSection(us, look.THICK);
    const N = sec.pts.length;
    const ring = [];
    for (let j = 0; j < xs.length; j++) {
      ring[j] =
        N === nu
          ? floorPts[j]
          : sec.pts.map((c) => project(surf(xs[j], frame, time, true, c.u, c.dr, c.dz), cam));
    }

    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    const quads = [];
    const steps = sec.closed ? N : N - 1;
    for (let j = bladeJ; j < last; j++) {
      const live = Math.max(hs[j], hs[j + 1]);
      for (let k = 0; k < steps; k++) {
        const k2 = (k + 1) % N;
        const a = ring[j][k], b = ring[j][k2];
        const c = ring[j + 1][k2], d = ring[j + 1][k];
        // which way is it facing? the screen-space winding says front
        // or back; the camera-space normal says how square-on it is
        const turn =
          (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (sec.closed && turn > 0) continue;        // a back face
        const e1x = b.cx - a.cx, e1y = b.cy - a.cy, e1z = b.cz - a.cz;
        const e2x = d.cx - a.cx, e2y = d.cy - a.cy, e2z = d.cz - a.cz;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const L = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        const face = Math.abs(nz) / L;
        for (const v of [a, b, c, d]) {
          if (v.x < sx0) sx0 = v.x; if (v.x > sx1) sx1 = v.x;
          if (v.y < sy0) sy0 = v.y; if (v.y > sy1) sy1 = v.y;
        }
        quads.push({ a, b, c, d, face, live, z: a.depth + c.depth });
      }
    }
    if (!quads.length) { sx0 = sy0 = 0; sx1 = sy1 = 1; }

    /*
      Why this is drawn somewhere else first.

      Translucent patches that abut do not meet cleanly: each one's
      antialiased edge is blended separately, so a seam shows. Growing
      them to overlap is worse, not better — two translucent edges on
      top of each other are MORE opaque, so the seams come back bright,
      as a grid laid over the surface.

      So the surface is built opaque on a canvas of its own, where
      shading is carried by colour rather than by alpha and abutting
      patches blend into each other instead of over the background.
      Then the whole thing is composited once, at the opacity the
      surface wants. One blit, no seams, and the shading is unchanged
      because it was only ever a ratio.
    */
    const buf = info.buf || (info.buf = document.createElement("canvas"));
    if (buf.width !== w || buf.height !== h) { buf.width = w; buf.height = h; info.bufRect = null; }
    const bx = buf.getContext("2d");
    const tx = (w - box.w * fit) / 2 - box.x * fit;
    const ty = (h - box.h * fit) / 2 - box.y * fit;
    const pad = 0.5 / fit;   // half a pixel, in the units we draw in
    /*
      Only the surface's own rectangle is cleared and composited, and
      the previous frame's too, or the last position stays behind as a
      ghost of itself.
    */
    const m = 3;
    const now = {
      x: Math.max(0, Math.floor(sx0 * fit + tx) - m),
      y: Math.max(0, Math.floor(sy0 * fit + ty) - m),
      r: Math.min(w, Math.ceil(sx1 * fit + tx) + m),
      b: Math.min(h, Math.ceil(sy1 * fit + ty) + m),
    };
    const was = info.bufRect || now;
    const clr = {
      x: Math.max(0, Math.min(now.x, was.x)),
      y: Math.max(0, Math.min(now.y, was.y)),
      r: Math.min(w, Math.max(now.r, was.r)),
      b: Math.min(h, Math.max(now.b, was.b)),
    };
    info.bufRect = now;
    bx.setTransform(1, 0, 0, 1, 0, 0);
    bx.clearRect(clr.x, clr.y, clr.r - clr.x, clr.b - clr.y);
    bx.setTransform(fit, 0, 0, fit, tx, ty);
    bx.lineJoin = "round";

    /*
      A palette, built once a frame, instead of a colour string per
      patch. Every assignment to fillStyle costs a CSS colour parse, and
      at a few thousand patches a frame across eight tiles that parse
      was most of the drawing's time.
    */
    const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const bg = hex(css("--bg")), bodyC = hex(body), edgeC = hex(edge);
    const STEPS = 32;
    const ramp = (to) => {
      const out = [];
      for (let n = 0; n < STEPS; n++) {
        const t = n / (STEPS - 1);
        out.push(
          "rgb(" +
            Math.round(bg[0] + (to[0] - bg[0]) * t) + "," +
            Math.round(bg[1] + (to[1] - bg[1]) * t) + "," +
            Math.round(bg[2] + (to[2] - bg[2]) * t) + ")"
        );
      }
      return out;
    };
    const palBody = ramp(bodyC), palEdge = ramp(edgeC);

    // painter's order: without it a far patch paints over a near one
    quads.sort((m2, n2) => n2.z - m2.z);
    for (const q of quads) {
      const t = lift(q.z / 2);
      const shade = Math.max(
        0,
        Math.min(1, (look.GHOST * 0.8 + q.live) * (0.22 + 0.78 * q.face) * (0.45 + 0.55 * t))
      );
      bx.fillStyle = (q.live > 0.6 ? palEdge : palBody)[(shade * (STEPS - 1) + 0.5) | 0];
      /*
        Grow each patch half a pixel about its own middle, to cover the
        antialiased hairline where it meets its neighbour. On an opaque
        buffer the overlap is simply the same colour again; stroking
        each patch instead did the same job and made it six times
        slower.
      */
      const cx = (q.a.x + q.b.x + q.c.x + q.d.x) / 4;
      const cy = (q.a.y + q.b.y + q.c.y + q.d.y) / 4;
      bx.beginPath();
      for (let n2 = 0; n2 < 4; n2++) {
        const v = n2 === 0 ? q.a : n2 === 1 ? q.b : n2 === 2 ? q.c : q.d;
        const dx = v.x - cx, dy = v.y - cy;
        const L = Math.hypot(dx, dy) || 1;
        const g = (L + pad) / L;
        if (n2 === 0) bx.moveTo(cx + dx * g, cy + dy * g);
        else bx.lineTo(cx + dx * g, cy + dy * g);
      }
      bx.closePath();
      bx.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = sheer * look.FILL;
    const cw = Math.max(1, now.r - now.x), ch = Math.max(1, now.b - now.y);
    ctx.drawImage(buf, now.x, now.y, cw, ch, now.x, now.y, cw, ch);
    ctx.setTransform(fit, 0, 0, fit, tx, ty);
    ctx.globalAlpha = 1;
  }
  if (mode === 0)
  for (let j = bladeJ; j <= last; j++) {
    const live = hs[j];
    if (live < 0.02) continue;             // still: nothing to draw
    const t = lift(floorPts[j][mid].depth);
    const lit2 = litOf(live, 0.9);
    ctx.globalAlpha = sheer * aOf(lit2) * (0.38 + 0.62 * t);
    ctx.strokeStyle = live > 0.55 ? edge : body;
    ctx.lineWidth = ((0.8 + 1.6 * live) * wOf(lit2) * look.RIBW) / fit;
    ctx.beginPath();
    floorPts[j].forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  if (mode === 0)
  for (const k of [0, nu - 1]) {
    for (let j = bladeJ; j < last; j++) {
      const live = Math.max(hs[j], hs[j + 1]);
      const t = lift((floorPts[j][k].depth + floorPts[j + 1][k].depth) / 2);
      const lit3 = litOf(live, 0.6);
      ctx.globalAlpha = sheer * aOf(lit3) * (0.3 + 0.7 * t);
      ctx.strokeStyle = body;
      ctx.lineWidth = ((0.7 + 1.4 * live) * wOf(lit3) * look.EDGEW) / fit;
      seg(floorPts[j][k], floorPts[j + 1][k]);
    }
  }
  }

  /*
    The phoneme, at the mouth.

    Not in the crook of the shape, where the flat drawing puts it: in
    three dimensions the crook moves around as the camera does and the
    glyph goes with it. The lips do not — they are the one part of this
    that means the same thing from every angle, because that is where
    the sound leaves. So it sits just beyond them, pushed out along the
    tract's own direction, and drawn screen-aligned: a letter that
    turned with the camera would be unreadable half the time.
  */
  if (glyph) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const size = Math.max(9, h * look.IPA);
    // the frame was fitted with room for it, so this only catches the
    // odd frame where easing has not caught up
    const gap = size * 0.6;
    const X = Math.max(gap, Math.min(w - gap, glyph.x * fit + tx0));
    const Y = Math.max(gap, Math.min(h - gap, glyph.y * fit + ty0));

    ctx.font = "600 " + size + "px " + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lit2 = sheer * (0.45 + 0.55 * loud);

    /*
      One phoneme becoming the next.

      Not a dissolve between two letters standing in the same place —
      that says nothing about what the mouth did.

      Two numbers out of the articulation put the letter in a space of
      its own: where the constriction is, and how tight it is. Those are
      the two dimensions vowels and consonants actually share — place
      and degree — so one map holds all of them.

      Across is the tongue's index, back to front: /ɚ/ and /w/ at 11,
      /n/ at 15, /s/ and /e/ at 19, /j/ at 26. Up and down is the
      NARROWEST bore in the oral cavity, not the tongue's own diameter,
      which was the first thing I tried and could not tell /e/ from /s/
      — both sit at 3.5, because what separates them is the constriction
      in front of the tongue, not the tongue. By the bore they are 1.24
      against 0.28, which is the whole width of the space.

      Phonemes that genuinely share an articulation share a place: /s/
      and /z/ land on the same spot, because the only difference between
      them is voicing. That is right, and the letters differ anyway.

      Both numbers are eased along with the shape, so the letter travels
      the same path through the space that the mouth travels through its
      own.

      Then the change of symbol is a crossfade over that movement: the
      old letter stays where its own articulation put it and goes, the
      new one arrives from there and settles into its own corner,
      growing as it comes. What you read is one sound moving to another
      rather than two pictures swapping.
    */
    let bore = Infinity;
    for (let j = bladeJ; j <= last; j++) bore = Math.min(bore, dAt(frame, xs[j]));
    if (!isFinite(bore)) bore = 0.5;
    const nx = Math.max(-1, Math.min(1, ((frame.ti || 19) - 19) / 8));
    const ny = Math.max(-1, Math.min(1, (Math.sqrt(Math.max(0, bore)) - 0.62) / 0.42));
    const spread = size * look.IPASPACE;
    // close at the top, open at the bottom, the way the IPA chart is drawn
    const here = { x: X + nx * spread, y: Y + ny * spread };

    const st =
      info.ipa || (info.ipa = { cur: frame.p, from: here, at: here, t: 1, prev: "", on: 0 });
    if (frame.p && frame.p !== st.cur) {
      st.prev = st.cur;
      st.from = { x: st.at.x, y: st.at.y };
      st.cur = frame.p;
      st.t = 0;
    }
    /*
      Presence, so a phoneme arrives and leaves rather than being
      switched on. A gap does not clear the letter, it takes it away;
      the next one comes up out of nothing in its own time. Separate
      from the morph, because the two happen on different occasions: a
      change of sound is a move across the space, a gap is an absence.
    */
    const stepF = (dt || 1 / 60) / Math.max(0.02, look.IPAFADE);
    const target = frame.p ? 1 : 0;
    st.on += (target - st.on) * Math.min(1, stepF);
    if (st.on < 0.015 && !frame.p) st.on = 0;

    st.t = Math.min(1, st.t + (dt || 1 / 60) / Math.max(0.02, look.IPAMORPH));
    if (frame.p) st.at = here;
    const e = st.t * st.t * (3 - 2 * st.t);     // ease in and out

    /*
      Voiced it is set solid; whispered it is the outline of itself, and
      in between it is both, crossfading. The voicing arrives already
      eased, so this is a continuous thing rather than a switch.
    */
    const put = (ch, x, y, grow, alpha) => {
      if (!ch || alpha <= 0.004) return;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(grow, grow);
      if (voiced > 0.01) {
        ctx.globalAlpha = alpha * voiced;
        ctx.fillStyle = edge;
        ctx.fillText(ch, 0, 0);
      }
      if (voiced < 0.99) {
        const w2 = 1 - voiced;
        ctx.globalAlpha = alpha * w2 * 0.07;   // a breath of fill, so it is not a hole
        ctx.fillStyle = edge;
        ctx.fillText(ch, 0, 0);
        ctx.globalAlpha = alpha * w2;
        ctx.strokeStyle = edge;
        /*
          Thin. A heavier line than this does not read as an outline at
          all: the stems of a letter this size are only a few pixels
          across, so a four-pixel stroke fills them in and adds a pixel
          or two all round — measured, that drew MORE ink than the solid
          version, which is the opposite of inverted.
        */
        ctx.lineWidth = Math.max(0.9, size * 0.022) / grow;
        ctx.lineJoin = "round";
        ctx.strokeText(ch, 0, 0);
      }
      ctx.restore();
    };

    const body2 = lit2 * st.on;
    if (st.prev && st.t < 1)
      put(st.prev, st.from.x, st.from.y, 1 + 0.35 * e, body2 * (1 - e) * 0.9);
    put(
      st.cur,
      st.from.x + (here.x - st.from.x) * e,
      st.from.y + (here.y - st.from.y) * e,
      st.prev ? 0.55 + 0.45 * e : 1,
      body2 * (st.prev ? e : 1)
    );

  }
  ctx.globalAlpha = 1;
}
