/*
  scan/src/patched-pink-trombone.js
  ---------------------------------
  Loads the upstream Pink Trombone module, but gives it a working plosive burst
  on the way in. Nothing on disk is modified: both files are fetched as text,
  patched in memory, and imported as blob modules.

  ── why ─────────────────────────────────────────────────────────────────────
  A stop consonant is a closure plus a *burst*: the little explosion of air when
  the closure lets go. Pink Trombone models that as a "transient" — an impulse
  injected into the waveguide at the point of the closure. In this build the
  transient can never happen:

    1. Tract._updateTract() never resets `transients.obstruction.new` to -1, so
       once the tract has closed anywhere it counts as obstructed forever, and
       the release test (`obstruction.new == -1`) is never true.

    2. Even if it were, it pushes `new Transient(obstruction.new)` — position -1
       — instead of `obstruction.last`, the index where the closure actually was.
       Writing to `float64Array[-1]` is a silent no-op.

    3. Transient.amplitude returns `strength * Math.pow(-2, timeAlive * exponent)`.
       A negative base with a fractional exponent is NaN, which would poison the
       tract (there is an isNaN guard that resets it). Upstream Pink Trombone
       decays as `strength * Math.pow(2, -exponent * timeAlive)`.

  That is almost certainly why plosives sound unintelligible however you drive
  this synth from outside: you can interpolate the articulators all you like,
  but the burst itself is missing.

  ── what we do about it ─────────────────────────────────────────────────────
  Fixing (1) and (2) does restore automatic bursts, but they then fire off the
  tract's *geometry*: a constriction that is sliding into place while it narrows
  momentarily closes and re-opens, and you get a loud spurious click every time
  you arrive at a stop. Measured, not guessed.

  So instead we fix the decay (3), split the impulse between both directions of
  the waveguide the way upstream Pink Trombone does (injecting it only leftward
  is a lopsided low-frequency shove — the "balloon pop"), and add an explicit
  trigger: a new AudioParam
  called `burst`. A rising edge on it fires one transient at the narrowest point
  of the tract, with its strength scaled by the parameter value. The scan engine
  fires it at the exact moment it opens the closure, so the burst is a musical
  event you schedule and level, not a side effect of geometry. The two
  obstruction bugs are left alone, which keeps the automatic path inert.

  One more, unrelated: the glottis adds two simplex-noise drifts to the pitch
  unconditionally, so `vibratoGain = 0` still wanders about a quarter-tone. A
  fourth patch scales those by `vibratoWobble`, so setting wobble to 0 gives a
  genuinely steady pitch — which a choir needs. (The separate tenseness drift is
  left alone: it colours the tone, not the pitch.)
*/

const LOADER_URL = "/pink-trombone/src/pink-trombone.min.js";
const WORKLET_URL = "/pink-trombone/src/pink-trombone-worklet-processor.min.js";

const WORKLET_PATCHES = [
  {
    name: "transient-decay",
    why: "Math.pow(-2, x) is NaN for fractional x; upstream decays as pow(2, -x)",
    from: `return this.strength * Math.pow(-2, this.timeAlive * this.exponent);`,
    to: `return this.strength * Math.pow(2, -this.exponent * this.timeAlive);`,
  },
  {
    name: "burst-parameter",
    why: "adds a `burst` AudioParam so the burst can be triggered explicitly",
    from: `  {
    name: "tractLength",
    defaultValue: 44,
    minValue: 15,
    maxValue: 88,
  },
];`,
    to: `  {
    name: "tractLength",
    defaultValue: 44,
    minValue: 15,
    maxValue: 88,
  },
  {
    name: "burst",
    defaultValue: 0,
    minValue: 0,
    maxValue: 4,
  },
  {
    name: "burstDecay",
    defaultValue: 200,
    minValue: 20,
    maxValue: 4000,
  },
];`,
  },
  {
    name: "burst-trigger",
    why: "fires one transient at the tract's narrowest point on a rising edge of `burst`",
    from: `  _processTransients(seconds) {`,
    to: `  _processBurst(parameterSamples, seconds) {
    const burst = parameterSamples.burst || 0;
    if (burst <= 0.01) {
      this._burstArmed = false;
      return;
    }
    if (this._burstArmed) return;
    this._burstArmed = true;

    // the burst belongs at the closure, i.e. the narrowest point of the tract
    let position = 2;
    let narrowest = Infinity;
    for (let index = 2; index < this.length; index++) {
      if (this.diameter[index] < narrowest) {
        narrowest = this.diameter[index];
        position = index;
      }
    }
    const transient = new Transient(position, seconds);
    transient.strength = 0.3 * Math.min(1, burst);
    transient.exponent = parameterSamples.burstDecay || 200;
    this.transients.push(transient);
  }

  _processTransients(seconds) {`,
  },
  {
    name: "steady-pitch",
    why: "the glottis adds two unconditional simplex drifts to the pitch; scale them by vibratoWobble so a wobble of 0 can actually sing steady",
    from: `    vibrato += 0.02 * this.noise.simplex1(seconds * 4.07);
    vibrato += 0.04 * this.noise.simplex1(seconds * 2.15);`,
    to: `    vibrato += parameterSamples.vibratoWobble * 0.02 * this.noise.simplex1(seconds * 4.07);
    vibrato += parameterSamples.vibratoWobble * 0.04 * this.noise.simplex1(seconds * 2.15);`,
  },
  {
    name: "transient-balance",
    why: "the impulse is injected only into the leftward line, which is a lopsided low-frequency push — upstream splits it between both directions",
    from: `      this.left[transient.position] += transient.amplitude;
      transient.update(seconds);`,
    to: `      const halfAmplitude = transient.amplitude * 0.5;
      this.left[transient.position] += halfAmplitude;
      this.right[transient.position] += halfAmplitude;
      transient.update(seconds);`,
  },
  {
    name: "burst-call",
    why: "runs the burst check every sample, where parameterSamples is in scope",
    from: `    this._processTransients(seconds);
    this._processConstrictions(this.previousConstrictions, parameterSamples);`,
    to: `    this._processBurst(parameterSamples, seconds);
    this._processTransients(seconds);
    this._processConstrictions(this.previousConstrictions, parameterSamples);`,
  },
];

/**
 * @returns {Promise<{module: object, applied: string[], missed: string[]}>}
 */
export async function loadPatchedPinkTrombone({ patch = true, names = null } = {}) {
  const [loaderSrc, workletSrc] = await Promise.all(
    [LOADER_URL, WORKLET_URL].map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`could not fetch ${url} (${response.status})`);
      return response.text();
    })
  );

  const applied = [];
  const missed = [];
  let worklet = workletSrc;

  if (patch) {
    for (const p of WORKLET_PATCHES) {
      if (names && !names.includes(p.name)) {
        missed.push(p.name);
        continue;
      }
      if (worklet.includes(p.from)) {
        worklet = worklet.replace(p.from, p.to);
        applied.push(p.name);
      } else {
        missed.push(p.name);
      }
    }
  }

  const workletUrl = URL.createObjectURL(
    new Blob([worklet], { type: "text/javascript" })
  );

  const needle = `addModule("${WORKLET_URL}")`;
  if (!loaderSrc.includes(needle)) {
    throw new Error("could not find the worklet addModule() call to redirect");
  }
  const loader = loaderSrc.replace(needle, `addModule(${JSON.stringify(workletUrl)})`);
  const loaderUrl = URL.createObjectURL(
    new Blob([loader], { type: "text/javascript" })
  );

  const module = await import(/* webpackIgnore: true */ loaderUrl);
  return { module, applied, missed, total: WORKLET_PATCHES.length };
}

export { WORKLET_PATCHES };
