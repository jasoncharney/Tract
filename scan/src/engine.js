/*
  scan/src/engine.js
  ------------------
  A "scannable" articulation engine for Pink Trombone.

  A phoneme string becomes a strip of cells. A continuous position (mouse x, an
  OSC float, a MIDI CC...) scans the strip. Dwelling holds; moving performs the
  transition. Which kind of transition is decided per boundary:

    * POSITION-LOCKED (continuants: vowels, nasals, fricatives, approximants)
      The tract interpolates with your pointer. Slow down and the glide slows
      down. This is the "scan" behaviour.

    * TIME-LOCKED (stops, affricates)
      A stop is a closure plus a burst, and those want opposite timing. The
      release is ballistic: burst -> VOT/aspiration -> onset of the next
      phoneme, on its own fixed clock however slowly you are moving. That is
      what keeps stops intelligible at any scan speed.

  Stops come in two kinds, decided by position in the word:

    * WORD-FINAL stops are holdable. Dwell and the closure sits there — silent
      for /p t k/, a voice bar for /b d g/ — and it releases when you leave the
      word, when the gate closes, or when you lift the mouse.

    * EVERY OTHER STOP is pass-through. There is nothing to dwell on in a
      word-initial or medial stop, so arriving at one fires the whole gesture
      at once and lands on the next continuant. Its cell is drawn narrow to
      say so.

  The engine is driven by an explicit clock — voice.update(position, now) — and
  touches nothing but AudioParams, so it can be hosted anywhere.
*/

export const OPEN = 5; // constriction diameter that means "no constriction"

export const DEFAULTS = {
  // --- time-locked gesture timings (seconds) ---
  closeTime: 0.035, // arriving at a holdable stop
  passClose: 0.022, // arriving at a pass-through stop: brief, just enough pressure
  burstTime: 0.012, // closure -> open, the burst itself
  votVoiceless: 0.055, // aspiration after /p t k/ before voicing starts
  votVoiced: 0.012, // after /b d g/
  transition: 0.06, // post-burst move onto the next phoneme
  affricateClosure: 0.07, // how long /tʃ dʒ/ hold closure before self-releasing
  autoReleaseStops: false, // a held stop lets go by itself...
  maxClosure: 0.25, // ...after this long. It does not re-close.
  retriggerLockout: 0.14, // ignore a re-entry into the same stop within this

  // --- position-locked tracking ---
  smooth: 0.035, // ramp time for continuous tracking
  blend: 0.4, // fraction of a cell width spent transitioning (0 = hard steps)

  // --- level / voice ---
  attack: 0.03,
  release: 0.08,
  burstIntensity: 1,
  burstLevel: 0.5, // strength of the injected burst transient (0 = none)
  closureIntensityVoiced: 0.28, // voice bar during /b d g/
  voicenessVowel: 0.9,
  voicenessVoicedFric: 0.7,
  voicenessVoicelessFric: 0.08,
  stressSemitones: 0.75,

  // --- pitch ---
  glide: 0.05, // portamento
};

/* ------------------------------------------------------------------ *
 *  phoneme classification
 * ------------------------------------------------------------------ */

const STOPS = ["b", "d", "g", "p", "t", "k"];
const AFFRICATES = ["tʃ", "dʒ", "ʧ", "ʤ"];
const NASALS = ["m", "n", "ŋ"];
const APPROXIMANTS = ["l", "r", "ɹ", "w", "j", "ɚ"];
const FRICATIVES = ["f", "v", "s", "z", "ʃ", "ʒ", "θ", "ð", "h"];
const STRESS_MARKS = ["ˈ", "ˌ"];

// affricates in the source table only carry their fricative shape, so borrow a
// closure from the matching stop
const AFFRICATE_CLOSURE = { "tʃ": "t", "ʧ": "t", "dʒ": "d", "ʤ": "d" };

// cell widths, in units of an ordinary phoneme
const WIDTHS = {
  passThroughStop: 0.5,
  heldStop: 1.15,
  silence: 0.6,
  normal: 1,
};

export function classify(ipa, info) {
  if (STOPS.includes(ipa)) return "stop";
  if (AFFRICATES.includes(ipa)) return "affricate";
  if (NASALS.includes(ipa)) return "nasal";
  if (ipa === "h") return "aspirate";
  if (FRICATIVES.includes(ipa)) return "fricative";
  if (APPROXIMANTS.includes(ipa)) return "approximant";
  if (info && info.type === "consonant") return "fricative";
  return "vowel";
}

const NEUTRAL = {
  ti: 12.9,
  td: 2.43,
  fi: 41,
  fd: OPEN,
  bi: 10.5,
  bd: OPEN,
  v: 0.9,
  a: 1,
};

export function deconstructVoiceness(voiceness) {
  const tenseness = 1 - Math.cos(voiceness * Math.PI * 0.5);
  const loudness = Math.pow(tenseness, 0.25);
  return { tenseness, loudness };
}

function pose(constriction, voiceness, intensity) {
  const p = {
    ti: null,
    td: null,
    fi: null,
    fd: OPEN,
    bi: null,
    bd: OPEN,
    v: voiceness,
    a: intensity,
  };
  if (!constriction) return p;
  const { tongue, front, back } = constriction;
  if (tongue) {
    p.ti = tongue.index;
    p.td = tongue.diameter;
  }
  if (front) {
    p.fi = front.index;
    p.fd = front.diameter;
  }
  if (back) {
    p.bi = back.index;
    p.bd = back.diameter;
  }
  return p;
}

/** how much a parameter must move before it is worth scheduling again */
const EPSILON = {
  tongueIndex: 0.004,
  tongueDiameter: 0.002,
  frontIndex: 0.004,
  frontDiameter: 0.002,
  backIndex: 0.004,
  backDiameter: 0.002,
  tenseness: 0.001,
  loudness: 0.001,
  intensity: 0.001,
};

const TRACT_KEYS = ["ti", "td", "fi", "fd", "bi", "bd"];
const POSE_KEYS = ["ti", "td", "fi", "fd", "bi", "bd", "v", "a"];

export function lerpPose(a, b, t) {
  t = Math.max(0, Math.min(1, t));
  const out = {};
  for (const k of POSE_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

function withTract(base, tractSource) {
  const out = Object.assign({}, base);
  for (const k of TRACT_KEYS) out[k] = tractSource[k];
  return out;
}

/* ------------------------------------------------------------------ *
 *  track building
 * ------------------------------------------------------------------ */

/**
 * Turn an IPA string into scannable cells.
 * @param {string} ipaString  e.g. "kɹæˈk" (spaces become silent cells)
 * @param {object} table      the global `phonemes` table from src/utils.js
 * @param {object} cfg
 */
export function buildTrack(ipaString, table, cfg = DEFAULTS) {
  const cells = [];
  let wordIndex = 0;

  const chars = Array.from(ipaString || "");
  // the table has multi-character keys (tʃ, dʒ, eɪ, ɑ:, ɜ:ʳ ...) so greedily
  // match the longest key at each position
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);

  let i = 0;
  while (i < chars.length) {
    const rest = chars.slice(i).join("");
    const ch = chars[i];

    if (ch === " ") {
      cells.push(makeSilence(wordIndex));
      wordIndex++;
      i++;
      continue;
    }
    if (STRESS_MARKS.includes(ch)) {
      // the source dictionary puts the stress mark *after* the stressed vowel
      const target = cells[cells.length - 1];
      if (target) target.stress = ch === "ˈ" ? 1 : 0.5;
      i++;
      continue;
    }
    if (ch === ".") {
      cells.push(makeSilence(wordIndex));
      i++;
      continue;
    }

    const key = keys.find((k) => rest.startsWith(k));
    if (!key) {
      i++;
      continue;
    }
    cells.push(makeCell(key, table, cfg, wordIndex));
    i += key.length;
  }

  markStops(cells);
  resolveInheritance(cells);
  resolvePassThroughTargets(cells);
  return cells;
}

function makeSilence(wordIndex) {
  return {
    ipa: "·",
    cls: "silence",
    wordIndex,
    width: WIDTHS.silence,
    voiced: false,
    closes: false,
    passThrough: false,
    autoRelease: false,
    // a word gap is a gate closure, not something to interpolate through
    blendIn: false,
    blendOut: false,
    poses: [{ ti: null, td: null, fi: null, fd: OPEN, bi: null, bd: OPEN, v: 0.9, a: 0 }],
    stress: 0,
  };
}

function makeCell(ipa, table, cfg, wordIndex) {
  const info = table[ipa] || { constrictions: [{}] };
  const cls = classify(ipa, info);
  const voiced = "voiced" in info ? info.voiced : true;
  const cons = Array.isArray(info.constrictions)
    ? info.constrictions
    : [info.constrictions];

  const cell = {
    ipa,
    cls,
    voiced,
    wordIndex,
    width: WIDTHS.normal,
    example: info.example || "",
    stress: 0,
    closes: false,
    passThrough: false,
    autoRelease: false,
    wordFinal: false,
    blendIn: true,
    blendOut: true,
    poses: [],
    closurePose: null,
    releasePose: null,
    sustainPose: null,
  };

  switch (cls) {
    case "stop": {
      // markStops() decides holdable vs pass-through once neighbours are known
      cell.closurePose = pose(
        cons[0],
        voiced ? cfg.voicenessVowel : 0.05,
        voiced ? cfg.closureIntensityVoiced : 0
      );
      cell.releasePose = pose(cons[1] || cons[0], voiced ? 0.85 : 0.02, cfg.burstIntensity);
      cell.poses = [cell.closurePose];
      cell.blendIn = false;
      cell.blendOut = false;
      break;
    }
    case "affricate": {
      const closureKey = AFFRICATE_CLOSURE[ipa];
      const closureInfo = closureKey ? table[closureKey] : null;
      const closure = closureInfo
        ? (Array.isArray(closureInfo.constrictions)
            ? closureInfo.constrictions
            : [closureInfo.constrictions])[0]
        : cons[0];
      cell.closes = true;
      cell.autoRelease = true;
      cell.blendIn = false;
      cell.blendOut = true;
      cell.closurePose = pose(
        closure,
        voiced ? cfg.voicenessVowel : 0.05,
        voiced ? cfg.closureIntensityVoiced : 0
      );
      cell.poses = [cell.closurePose];
      // after the burst it settles into its own frication and sustains there
      cell.releasePose = pose(
        cons[0],
        voiced ? cfg.voicenessVoicedFric : cfg.voicenessVoicelessFric,
        1
      );
      cell.sustainPose = cell.releasePose;
      break;
    }
    case "fricative": {
      const v = voiced ? cfg.voicenessVoicedFric : cfg.voicenessVoicelessFric;
      cell.poses = cons.map((c) => pose(c, v, 1));
      break;
    }
    case "aspirate": {
      // /h/ has no shape of its own: it is a voiceless version of what follows
      cell.poses = [pose(null, 0, 0.9)];
      cell.inheritFrom = "next";
      break;
    }
    case "nasal":
    case "approximant":
    case "vowel":
    default: {
      cell.poses = cons.map((c) => pose(c, cfg.voicenessVowel, 1));
      break;
    }
  }

  if (cell.poses.length === 0) cell.poses = [pose(null, cfg.voicenessVowel, 1)];
  return cell;
}

/** a stop is holdable only at the end of a word; everywhere else it passes through */
function markStops(cells) {
  cells.forEach((cell, i) => {
    if (cell.cls !== "stop") return;
    const next = cells[i + 1];
    cell.wordFinal = !next || next.cls === "silence";
    if (cell.wordFinal) {
      cell.closes = true;
      cell.passThrough = false;
      cell.width = WIDTHS.heldStop;
    } else {
      cell.closes = false;
      cell.passThrough = true;
      cell.width = WIDTHS.passThroughStop;
    }
  });
}

/** fill in unspecified articulators by carrying the previous shape forward */
function resolveInheritance(cells) {
  const all = [];
  cells.forEach((cell) => {
    if (cell.closurePose) all.push(cell.closurePose);
    cell.poses.forEach((p) => {
      if (p !== cell.closurePose) all.push(p);
    });
    if (cell.releasePose) all.push(cell.releasePose);
  });

  let last = NEUTRAL;
  for (const p of all) {
    for (const k of TRACT_KEYS) {
      if (p[k] === null || p[k] === undefined) p[k] = last[k];
    }
    last = p;
  }

  // /h/ takes the shape of the following cell
  cells.forEach((cell, i) => {
    if (cell.inheritFrom !== "next") return;
    const next = cells[i + 1];
    if (!next) return;
    cell.poses = cell.poses.map((p) => withTract(p, next.poses[0]));
  });
}

/**
 * A pass-through stop has no sustainable state, so what it *tracks* as is the
 * onset of the next thing you can actually hold. Dwell on the /k/ of "crack"
 * and you are already on the /ɹ/.
 */
function resolvePassThroughTargets(cells) {
  cells.forEach((cell, i) => {
    if (!cell.passThrough) return;
    let target = null;
    for (let j = i + 1; j < cells.length; j++) {
      if (cells[j].passThrough) continue;
      target = cells[j].poses[0];
      break;
    }
    if (!target) {
      // nothing ahead: fall back to its own release shape
      target = cell.releasePose;
    }
    cell.trackPose = Object.assign({}, target);
    cell.poses = [cell.trackPose];
  });
}

/* ------------------------------------------------------------------ *
 *  the voice
 * ------------------------------------------------------------------ */

export class ScanVoice {
  /**
   * @param {object} params  AudioParams: tongueIndex, tongueDiameter,
   *   frontIndex, frontDiameter, backIndex, backDiameter, tenseness, loudness,
   *   intensity, frequency, tractLength, burst
   * @param {object} cfg
   */
  constructor(params, cfg = {}) {
    this.params = params;
    this.cfg = Object.assign({}, DEFAULTS, cfg);
    this.cells = [];
    this.curCell = -1;
    this.closed = false;
    this.released = true;
    this.closedAt = 0;
    this.lockUntil = 0;
    this.gate = 1;
    this.whisper = false;
    this.tractLength = 44;
    this.note = 45.5; // ~140 Hz
    this.bend = 0;
    this.position = 0;
    this.lastPose = Object.assign({}, NEUTRAL);
    this.scheduled = {}; // last value written per parameter
    this.onGesture = null; // (name, cell) => void, for the UI
  }

  set(key, value) {
    if (key in this.cfg) this.cfg[key] = value;
  }

  setTrack(cells) {
    this.cells = cells;
    this.curCell = -1;
    this.closed = false;
    this.released = true;
    this.lockUntil = 0;
  }

  /* ---------------- parameter plumbing ---------------- */

  _norm(index) {
    return index * (this.tractLength / 44);
  }

  /** forget what we think each parameter holds, after writing one directly */
  invalidate() {
    this.scheduled = {};
  }

  _ramp(param, value, now, time, key) {
    if (!param) return;
    if (!isFinite(value)) return;
    // re-ramping a parameter to the value it already has, sixty times a second,
    // is pure churn: it burns CPU and each cancelAndHold can nudge the value
    if (key !== undefined) {
      const last = this.scheduled[key];
      if (last !== undefined && Math.abs(last - value) < (EPSILON[key] || 0.001)) return;
      this.scheduled[key] = value;
    }
    try {
      param.cancelAndHoldAtTime(now);
    } catch (e) {
      param.cancelScheduledValues(now);
    }
    param.linearRampToValueAtTime(value, now + Math.max(0.001, time));
  }

  _at(param, value, time) {
    if (!param || !isFinite(value)) return;
    param.linearRampToValueAtTime(value, time);
  }

  /** a short rectangular pulse on a parameter: the burst trigger */
  _pulse(param, value, at, width = 0.008) {
    if (!param) return;
    try {
      param.cancelScheduledValues(at);
    } catch (e) {}
    param.setValueAtTime(value, at);
    param.setValueAtTime(0, at + width);
  }

  _poseValues(p) {
    const v = this.whisper ? 0 : p.v;
    const { tenseness, loudness } = deconstructVoiceness(v);
    return {
      tongueIndex: this._norm(p.ti),
      tongueDiameter: p.td,
      frontIndex: this._norm(p.fi),
      frontDiameter: p.fd,
      backIndex: this._norm(p.bi),
      backDiameter: p.bd,
      tenseness,
      loudness,
      intensity: Math.max(0, Math.min(1, p.a * this.gate)),
    };
  }

  applyPose(p, now, time) {
    const vals = this._poseValues(p);
    for (const key in vals) this._ramp(this.params[key], vals[key], now, time, key);
    this.lastPose = p;
  }

  /** schedule a sequence of [{t, pose}] as absolute ramps from `now` */
  scheduleGesture(steps, now, lockFor, name, cell) {
    for (const key in this.params) {
      const param = this.params[key];
      if (!param || key === "frequency" || key === "tractLength" || key === "burst")
        continue;
      try {
        param.cancelAndHoldAtTime(now);
      } catch (e) {
        param.cancelScheduledValues(now);
      }
    }
    this.invalidate();
    steps.forEach(({ t, pose: p }) => {
      const vals = this._poseValues(p);
      const when = now + Math.max(0.001, t);
      for (const key in vals) {
        this._at(this.params[key], vals[key], when);
        this.scheduled[key] = vals[key]; // the gesture's last write wins
      }
      this.lastPose = p;
    });
    this.lockUntil = now + lockFor;
    if (this.onGesture) this.onGesture(name, cell);
  }

  /* ---------------- poses along the strip ---------------- */

  cellAt(pos) {
    if (this.cells.length === 0) return -1;
    return Math.max(0, Math.min(this.cells.length - 1, Math.floor(pos)));
  }

  startPose(i) {
    const c = this.cells[i];
    if (!c) return this.lastPose;
    if (c.released && c.sustainPose) return c.sustainPose;
    return c.poses[0];
  }

  endPose(i) {
    const c = this.cells[i];
    if (!c) return this.lastPose;
    if (c.cls === "affricate" && c.sustainPose) return c.sustainPose;
    return c.poses[c.poses.length - 1];
  }

  /** the pose a gesture should land on when it arrives at cell i */
  entryPose(i) {
    const cell = this.cells[i];
    if (!cell) return this.lastPose;
    if (cell.passThrough) return cell.trackPose;
    return cell.poses[0];
  }

  /** the articulation implied by a continuous position */
  poseAtPosition(pos) {
    const i = this.cellAt(pos);
    const cell = this.cells[i];
    if (!cell) return this.lastPose;
    const f = Math.max(0, Math.min(1, pos - i));
    const blend = Math.max(0.0001, Math.min(0.9, this.cfg.blend));
    const edge = blend / 2;

    if (f < edge && i > 0) {
      const prev = this.cells[i - 1];
      if (prev.blendOut && cell.blendIn) {
        const k = 0.5 + f / blend; // 0.5 -> 1 across the incoming half
        return lerpPose(this.endPose(i - 1), this.startPose(i), k);
      }
    }
    if (f > 1 - edge && i < this.cells.length - 1) {
      const next = this.cells[i + 1];
      if (cell.blendOut && next.blendIn) {
        const k = (f - (1 - edge)) / blend; // 0 -> 0.5 across the outgoing half
        return lerpPose(this.endPose(i), this.startPose(i + 1), k);
      }
    }

    // inside the core: diphthongs glide across it, everything else holds
    const core = 1 - blend;
    const u = core <= 0 ? 0 : Math.max(0, Math.min(1, (f - edge) / core));
    const poses = cell.released && cell.sustainPose ? [cell.sustainPose] : cell.poses;
    if (poses.length === 1) return poses[0];
    const seg = u * (poses.length - 1);
    const a = Math.min(poses.length - 2, Math.floor(seg));
    return lerpPose(poses[a], poses[a + 1], seg - a);
  }

  /* ---------------- gestures ---------------- */

  /** arrive at a holdable stop and sit on the closure */
  fireClosure(i, now) {
    const cell = this.cells[i];
    this.scheduleGesture(
      [{ t: this.cfg.closeTime, pose: cell.closurePose }],
      now,
      this.cfg.closeTime,
      "close",
      cell
    );
    this.curCell = i;
    this.closed = true;
    this.released = false;
    this.closedAt = now;
    cell.released = false;
    cell.firedAt = now;
  }

  /**
   * The burst. Fixed duration regardless of how fast the pointer is moving:
   * pressure -> open + noise -> VOT/aspiration -> next phoneme.
   */
  _burstSteps(cell, target, closeTime, now) {
    const cfg = this.cfg;
    const closure = cell.closurePose;
    const rel = cell.releasePose || closure;
    const voiced = cell.voiced;
    const vot = voiced ? cfg.votVoiced : cfg.votVoiceless;

    const pressure = Object.assign({}, closure, {
      a: voiced ? Math.max(closure.a, 0.5) : cfg.burstIntensity * 0.9,
      v: voiced ? 0.85 : 0.02,
    });
    const burst = Object.assign({}, rel, {
      a: cfg.burstIntensity,
      v: voiced ? 0.85 : 0.02,
    });
    const aspirate = Object.assign({}, lerpPose(rel, target, 0.55), {
      v: voiced ? 0.85 : 0.05,
      a: Math.max(0.6, target.a),
    });

    const steps = [
      { t: closeTime + 0.001, pose: pressure },
      { t: closeTime + cfg.burstTime, pose: burst },
      { t: closeTime + cfg.burstTime + vot, pose: aspirate },
      { t: closeTime + cfg.burstTime + vot + cfg.transition, pose: target },
    ];
    const lock = closeTime + cfg.burstTime + vot + cfg.transition;

    // the transient is turbulence, not voicing, so it fires even when whispering
    if (cfg.burstLevel > 0) {
      this._pulse(
        this.params.burst,
        cfg.burstLevel * (voiced ? 0.6 : 1),
        now + closeTime + Math.max(0.002, cfg.burstTime - 0.002)
      );
    }
    return { steps, lock };
  }

  /** let go of a closure that was being held */
  fireRelease(fromIndex, toIndex, now, { toSilence = false } = {}) {
    const from = this.cells[fromIndex];
    if (!from) return;
    const rel = from.releasePose || from.closurePose;

    let target;
    if (toSilence) {
      target = Object.assign({}, rel, { a: 0 });
    } else if (from.cls === "affricate") {
      target = from.sustainPose || rel;
    } else {
      const toCell = this.cells[toIndex];
      target =
        toCell && toCell.cls !== "silence"
          ? this.entryPose(toIndex)
          : Object.assign({}, rel, { a: 0 });
    }

    const { steps, lock } = this._burstSteps(from, target, 0, now);
    this.scheduleGesture(steps, now, lock, "burst", from);

    from.released = true;
    from.firedAt = now;
    this.released = true;
    this.closed = false;

    if (toSilence) {
      this.curCell = fromIndex;
      return;
    }

    const toCell = this.cells[toIndex];
    if (toCell && toCell.closes) {
      // released straight into another holdable closure
      this.closed = true;
      this.closedAt = now + lock;
      this.released = false;
      toCell.released = false;
    }
    this.curCell = toIndex;
  }

  /**
   * A word-initial or medial stop: closure and burst in one movement, landing
   * on the next thing you can hold. There is no dwelling on it.
   */
  firePassThrough(i, now) {
    const cell = this.cells[i];
    const target = cell.trackPose;
    const { steps, lock } = this._burstSteps(cell, target, this.cfg.passClose, now);
    this.scheduleGesture(steps, now, lock, "stop", cell);
    this.curCell = i;
    this.closed = false;
    this.released = true;
    cell.firedAt = now;
  }

  /** a word gap: close the gate rather than interpolating across it */
  enterSilence(i, now) {
    const prev = this.cells[this.curCell];
    if (prev && prev.closes && this.closed && !this.released) {
      this.fireRelease(this.curCell, i, now);
      this.curCell = i;
      return;
    }
    this._ramp(this.params.intensity, 0, now, this.cfg.release, "intensity");
    this.lockUntil = now + this.cfg.release;
    this.curCell = i;
    this.closed = false;
    this.released = true;
    if (this.onGesture) this.onGesture("gap", this.cells[i]);
  }

  enterCell(i, now) {
    const prev = this.cells[this.curCell];
    const next = this.cells[i];
    if (!next) return;

    // leaving a held closure always releases it, wherever you are going
    if (prev && prev.closes && this.closed && !this.released) {
      this.fireRelease(this.curCell, i, now);
      return;
    }

    if (next.cls === "silence") {
      this.enterSilence(i, now);
      return;
    }

    const recentlyFired =
      next.firedAt !== undefined && now - next.firedAt < this.cfg.retriggerLockout;

    if (next.passThrough) {
      if (recentlyFired) {
        this.curCell = i;
        return;
      }
      this.firePassThrough(i, now);
      return;
    }
    if (next.closes) {
      if (recentlyFired) {
        this.curCell = i;
        return;
      }
      this.fireClosure(i, now);
      return;
    }

    this.curCell = i;
    this.closed = false;
    this.released = true;
  }

  /* ---------------- the driving loop ---------------- */

  /**
   * @param {number} pos  continuous position in cell units (index + fraction)
   * @param {number} now  AudioContext time
   */
  update(pos, now) {
    this.position = pos;
    if (this.cells.length === 0) return;
    if (now < this.lockUntil) return; // a ballistic gesture owns the tract

    const i = this.cellAt(pos);
    if (i !== this.curCell) {
      this.enterCell(i, now);
      return;
    }

    const cell = this.cells[i];
    if (!cell) return;

    if (cell.cls === "silence") {
      this._ramp(this.params.intensity, 0, now, this.cfg.release, "intensity");
      return;
    }

    // a held closure: silent, or a voice bar, until you leave
    if (cell.closes && this.closed && !this.released) {
      const held = now - this.closedAt;
      if (cell.autoRelease && held >= this.cfg.affricateClosure) {
        this.fireRelease(i, i, now);
        this.curCell = i;
        return;
      }
      if (this.cfg.autoReleaseStops && held >= this.cfg.maxClosure) {
        // let go into its own release shape and STAY there — no re-closing
        const target = Object.assign({}, cell.releasePose, { a: 1 });
        const { steps, lock } = this._burstSteps(cell, target, 0, now);
        this.scheduleGesture(steps, now, lock, "burst", cell);
        cell.released = true;
        cell.firedAt = now;
        this.closed = false;
        this.released = true;
        this.curCell = i;
        return;
      }
      return;
    }

    this.applyPose(this.poseAtPosition(pos), now, this.cfg.smooth);
  }

  /* ---------------- outside control ---------------- */

  setGate(on, now) {
    const wasOn = this.gate > 0;
    if (!on) {
      const cell = this.cells[this.curCell];
      if (cell && cell.closes && this.closed && !this.released) {
        // a held stop still gets its burst on the way out — schedule it while
        // the gate is still open, or every step of it would be multiplied by 0
        this.fireRelease(this.curCell, this.curCell, now, { toSilence: true });
        this.gate = 0;
        return;
      }
      this.gate = 0;
      this._ramp(this.params.intensity, 0, now, this.cfg.release, "intensity");
      this.lockUntil = now + this.cfg.release;
      return;
    }
    this.gate = 1;
    if (!wasOn) {
      this.lockUntil = 0;
      this.curCell = -1; // re-enter, so landing on a stop articulates it
      this.closed = false;
      this.released = true;
      this.cells.forEach((cell) => {
        cell.firedAt = undefined;
        cell.released = false;
      });
    }
  }

  setNote(note, now, glide) {
    this.note = note;
    this._ramp(
      this.params.frequency,
      this.frequency(),
      now,
      glide === undefined ? this.cfg.glide : glide
    );
  }

  setBend(semitones, now) {
    this.bend = semitones;
    this._ramp(this.params.frequency, this.frequency(), now, 0.02);
  }

  frequency() {
    const cell = this.cells[this.curCell];
    const stress = cell ? cell.stress * this.cfg.stressSemitones : 0;
    return 440 * Math.pow(2, (this.note + this.bend + stress - 69) / 12);
  }

  setTractLength(length, now) {
    this.invalidate();
    this.tractLength = Math.max(15, Math.min(88, length));
    this._ramp(this.params.tractLength, this.tractLength, now, 0.05);
    this.applyPose(this.lastPose, now, 0.05);
  }

  setWhisper(on, now) {
    this.invalidate();
    this.whisper = !!on;
    this.applyPose(this.lastPose, now, 0.05);
  }
}
