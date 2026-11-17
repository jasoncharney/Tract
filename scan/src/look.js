/*
  scan/src/look.js — what the wall looks like, and who decides it.

  One list of knobs, imported by both ends, because the desk draws the sliders
  from it and the stage reads the values, and two copies of a list like this
  drift apart the first time a default changes.

  The split that matters:

    the LOOK    every knob below. Settled in rehearsal, saved once, and not
                touched again during a performance.
    the ANGLES  yaw, pitch and perspective only, per part, per phrase. The
                three that are worth moving while the piece runs.

  Angles are per PART, not per player. Nine players share four parts at the
  premiere, so a camera saved per part would put the two players on II in
  lockstep — the one thing a room of laptops never looks like. Each tile is
  therefore nudged off its part's angle by where it sits on the wall, as if
  one eye in front of the middle were looking at all of them: the tile at the
  top of the ring is seen straight on, and each one round from it a little
  more from the side. It used to be a nudge hashed from the machine's name,
  which made nine tracts look scattered rather than arranged in a space.
*/

/** name, default, min, max, step, what it does */
export const KNOBS = [
  ["SHEET", 42, 10, 90, 1, "half-width of the tongue sheet"],
  ["RIBS", 5, 3, 9, 1, "points across it"],
  ["GROOVE", 16, 0, 40, 1, "how much the sheet dishes"],
  ["HOLD", 0.3, 0.05, 30, 0.05, "seconds a movement stays lit"],
  ["GAIN", 7, 1, 20, 0.5, "how little counts as movement"],
  ["GHOST", 0.3, 0, 0.8, 0.01, "what a still section is worth"],
  ["SHIMMER", 2.2, 0, 6, 0.1, "loudness as movement"],
  ["WOBBLE", 1, 0, 2, 0.05, "how much the shape shivers with loudness (1 is upstream's)"],
  ["WOBHZ", 8, 0.25, 12, 0.25, "and how fast the shiver runs along it"],
  ["RIBW", 1.4, 0.1, 12, 0.1, "line weight: the rings"],
  ["EDGEW", 1, 0.1, 12, 0.1, "line weight: the lines along its length"],
  ["GHOSTW", 1, 0.1, 12, 0.1, "line weight: the floor through the whole tract"],
  ["BYWIDTH", 0.75, 0, 1, 0.01, "how much of the fade is weight rather than opacity"],
  ["GLOW", 0.6, 0, 2, 0.05, "a soft light behind the tract (0 is the bare wire)"],
  ["GLOWR", 0.025, 0.005, 0.1, 0.005, "how far the glow spreads, as a share of the tile"],
  ["ROOF", 0.5, 0, 1, 0.01, "how strongly the roof of the mouth is drawn"],
  ["ROOFTINT", 0.35, 0, 1, 0.01, "the roof's colour, from the dim grey (0) to the bright edge (1)"],
  ["ROOFW", 1.4, 0.1, 6, 0.1, "line weight: the roof"],
  ["IPA", 0.1, 0, 0.3, 0.005, "the phoneme at the mouth, as a share of the tile (0 is off)"],
  ["IPAEASE", 0.12, 0.02, 1, 0.01, "how hard the phoneme follows the mouth"],
  ["IPASPACE", 0.5, 0, 2, 0.05, "how far the vowel space moves the phoneme"],
  ["IPAMORPH", 0.22, 0.02, 1.5, 0.02, "seconds for one phoneme to become the next"],
  ["IPAFADE", 0.3, 0.02, 2, 0.02, "seconds for the phoneme to come and go at a gap"],
  ["EASE", 0.22, 0.04, 1, 0.01, "how hard it chases the feed"],
  ["CAMEASE", 0.02, 0.002, 0.3, 0.002, "how fast a camera swings to a new angle"],
  ["FILL", 1, 0, 1, 0.01, "how solid the filled surface is"],
  ["SMOOTH", 3, 1, 8, 1, "samples per section on the surface modes"],
  ["THICK", 9, 0, 30, 0.5, "how thick the tongue is (0 is a flat plane)"],
  ["YAW", -1.5, -1.5, 0.3, 0.01, "how far round you stand (positive swings toward the throat)"],
  ["PITCH", 0, 0, 0.8, 0.01, "and how far above (never below)"],
  ["PERSPECTIVE", 1500, 400, 6000, 50, "a little, not a lot"],
];

/*
  Never from behind the tongue. Positive yaw swings the camera round to the
  throat end — at 1.5 it looks down the tract from behind the root of the
  tongue toward the lips — and negative pitch puts it underneath, looking up
  at the underside. Both read as the back of the thing rather than the
  thing. Chosen by eye from a 5x5 grid of yaw against pitch on the recorded
  phrase (experiments/tract-3d), not computed.

  The knobs stop short of these limits by the default spread, 0.22 and 0.1,
  so a part saved at the edge of a slider still has its seats fanned out by
  the parallax. VIEW is the hard limit on the angle a tile is finally
  aimed at, after parallax and shuffle, which is the only place a shuffle's
  nudge or a wide spread can be caught.
*/
export const VIEW = { yawMax: 0.5, pitchMin: -0.1 };

/** an aim with the back of the tongue kept out of it */
export function inView(aim) {
  return Object.assign({}, aim, {
    yaw: Math.min(VIEW.yawMax, aim.yaw),
    pitch: Math.max(VIEW.pitchMin, aim.pitch),
  });
}

/** the three that move during a performance, per part, per phrase */
export const ANGLES = ["YAW", "PITCH", "PERSPECTIVE"];

/** which drawing. "ribbon" is what the wall first drew; the tract in space is the default now. */
export const SURFACES = ["lines", "filled", "closed"];

export function defaults() {
  const look = { renderer: "wire", surface: "lines" };
  for (const [name, value] of KNOBS) look[name] = value;
  return look;
}

/**
 * How far a tile's camera sits off its part's angle, from where the tile is:
 * `where` is its centre, -1..1 across and down the wall. A tile right of
 * centre is seen from a little further left (yaw up), one below centre from a
 * little further above (pitch up), and `spread` is how much at the edge.
 */
export function parallaxOffset(where, spread) {
  if (!where) return { yaw: 0, pitch: 0 };
  return {
    yaw: where.x * (spread && spread.yaw !== undefined ? spread.yaw : 0.22),
    pitch: where.y * (spread && spread.pitch !== undefined ? spread.pitch : 0.1),
  };
}

/**
 * The spread for one phrase. look.json may give a phrase its own beside its
 * parts — phrases["2"].spread = { yaw, pitch } — and whatever it leaves out
 * comes from the piece's. The desk and the tuning page both ask this, so the
 * two cannot disagree about which wins.
 */
export function spreadFor(phrases, phrase, spread) {
  const own = ((phrases || {})[String(phrase)] || {}).spread || {};
  return Object.assign({ yaw: 0.22, pitch: 0.1 }, spread || {}, own);
}

/**
 * A shuffle is a seed, not a list of angles. The desk sends one number and
 * every wall derives the same offsets from it, which means a projector that
 * reconnects mid-piece lands on the same angles as the one that did not.
 * `who` is the part, so players on one part share their offset.
 */
export function shuffleOffset(who, seed) {
  if (!seed) return { yaw: 0, pitch: 0 };
  let h = 2166136261 ^ (seed >>> 0);
  for (let i = 0; i < String(who).length; i++) {
    h ^= String(who).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 4096) / 4096 - 0.5;
  const b = (((h >>> 7) >>> 0) % 4096) / 4096 - 0.5;
  /* `yaw` and `pitch` are a nudge off an angle someone saved. `anyYaw` is for
     a part with nothing saved: anywhere across the YAW knob — which now
     stops short of the throat end, so this is everywhere from the lips round
     to just past side on. */
  const [, , lo, hi] = KNOBS.find((k) => k[0] === "YAW");
  return { yaw: a * 1.5, pitch: b * 0.7, anyYaw: lo + (a + 0.5) * (hi - lo) };
}

/**
 * Where one player's camera is pointed: the angle saved for their part, the
 * parallax of where their tile sits on the wall, and the shuffle on top of
 * both. The shuffle is the only part of this that is
 * not written down, and it lasts exactly until the next phrase's angles
 * arrive — which is what makes it safe to press mid-piece.
 *
 * The shuffle is keyed by PART, not machine: every player on a part swings
 * to the same new angle and only the parallax tells them apart, so the wall
 * still reads as four parts rather than nine strangers. A part with no yaw
 * saved has nothing to nudge, so the shuffle picks its yaw outright.
 *
 * `info` needs `part` and `where`; `angles` are this phrase's, by part, as the
 * desk sends them, and `spread` the one that applies to this phrase.
 */
export function aimAt(info, { look, angles, spread, shuffle }) {
  const saved = (angles || {})[String(info.part)] || {};
  const seat = parallaxOffset(info.where, spread);
  const stir = shuffleOffset("part " + info.part, shuffle);
  // last, so neither a shuffle's nudge nor a wide spread can swing a tile
  // round behind the tongue — see VIEW, above
  return inView({
    yaw:
      (saved.yaw !== undefined ? saved.yaw + stir.yaw : shuffle ? stir.anyYaw : look.YAW) + seat.yaw,
    pitch: (saved.pitch === undefined ? look.PITCH : saved.pitch) + seat.pitch + stir.pitch,
    perspective: saved.perspective === undefined ? look.PERSPECTIVE : saved.perspective,
  });
}
