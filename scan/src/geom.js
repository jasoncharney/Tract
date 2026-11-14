/*
  scan/src/geom.js — upstream's numbers, in one place.

  The arc the tract is drawn along, and the shiver that runs through it. Both
  drawings need them and both used to carry their own copy; two copies of a
  constant like PT.radius are two chances to change one and not the other.
*/

export const PT = {
  origin: { x: 340, y: 460 },
  radius: 298,
  scale: 60,
  angle: { scale: 0.64, offset: -0.25 },
  box: { w: 600, h: 500 },
};

export function angleAt(index, lipStart) {
  return PT.angle.offset + (index * PT.angle.scale * Math.PI) / (lipStart - 1);
}

/** upstream's wobble: the whole shape shivers with how loud the tract is.
 *  50 rad/s is upstream's own rate, about 8 Hz — near enough the 6 Hz vibrato
 *  that on a held note it reads as the voice, not as the drawing. */
export function wobbleAt(index, length, amplitude, time, rate = 50) {
  return (amplitude * 0.03 * Math.sin(2 * index - rate * time) * index) / length;
}

/**
 * The fitted box, eased rather than snapped. Upstream's canvas is mostly
 * empty around the arc and a projector cannot afford empty, so each drawing
 * measures what it is about to draw and fits that to the tile — and eases the
 * fit, or every closure of the lips would jump the scale.
 */
export function easeBox(info, box) {
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
