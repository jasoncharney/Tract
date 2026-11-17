/*
  scan/src/wall.js — where the tiles go on the wall, and where the words go
  among them.

  Pure arithmetic on rectangles, so the stage and the tuning page (tune.html)
  lay out the same wall from the same code. These lived in stage.js, which
  cannot be imported anywhere else: it opens its socket when it loads.
*/

import { PT } from "./geom.js";

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

export function placeRing(count, width, height) {
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
export function placeGrid(count, width, height) {
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

/* ================================================================ *
 *  the words in the middle of a ring
 *
 *  A ring is a frame with nothing in it, and the bottom strip was costing
 *  every tract on it 15vh to put the words somewhere else. So in a ring
 *  they go in the hole, and the wall keeps its full height. Under three
 *  players there is no hole — one sits in the middle, two stack — so the
 *  words stay along the bottom.
 * ================================================================ */
export const RING_HOLE_FROM = 3;

/**
 * The biggest rectangle centred on the wall that no tile touches. Tried at
 * forty heights: at each, the tiles level with that band are the ones that
 * limit its width, and the widest-by-area wins. Centred because a ring is
 * symmetric and the words should read as being in it, not merely beside it.
 */
export function ringHole(spots, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  let best = null;
  for (let k = 1; k <= 40; k++) {
    const hh = (k / 40) * (height / 2);
    let hw = width / 2;
    for (const s of spots) {
      if (s.y < cy + hh && s.y + s.h > cy - hh) {
        const gap = s.x + s.w <= cx ? cx - (s.x + s.w) : s.x >= cx ? s.x - cx : 0;
        hw = Math.min(hw, gap);
      }
    }
    if (hw <= 0) continue;
    if (!best || hw * hh > best.hw * best.hh) best = { hw, hh };
  }
  if (!best) return null;
  // air, so a letter is never against a tile's edge
  const hw = best.hw * 0.9;
  const hh = best.hh * 0.9;
  return { x: cx - hw, y: cy - hh, w: 2 * hw, h: 2 * hh };
}
