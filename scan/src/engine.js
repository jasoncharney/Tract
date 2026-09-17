/*
  scan/src/engine.js
  ------------------
  A "scannable" articulation engine for Pink Trombone.

  The idea: a phoneme string becomes a strip of cells. A continuous position
  (mouse x, an OSC float, a MIDI CC...) scans the strip. Dwelling on a cell
  holds that articulation indefinitely; moving between cells performs the
  transition.

  Two kinds of transition, chosen automatically:

    * POSITION-LOCKED (continuants: vowels, nasals, fricatives, approximants)
      The tract interpolates with your pointer. Slow down and the diphthong
      glide slows down. This is the "scan" behaviour.

    * TIME-LOCKED (stops, affricates)
      A stop is a closure plus a burst. The closure can be held forever (it is
      silent, or a voice bar for /b d g/), but the *release* is a ballistic
      gesture: burst -> VOT/aspiration -> onset of the next phoneme, on its own
      fixed clock no matter how slowly you are moving. That is what makes /t/
      and /d/ intelligible at any scan speed; interpolating through them just
      smears them into fricatives.

  The engine is driven by an explicit clock (`now`, in AudioContext seconds) so
  the exact same code runs live (rAF) and offline (OfflineAudioContext render).
*/

export const OPEN = 5; // constriction diameter that means "no constriction"

export const DEFAULTS = {
  // --- time-locked gesture timings (seconds) ---
  closeTime: 0.035, // how fast the tract closes when you arrive at a stop
  burstTime: 0.012, // closure -> open, the burst itself
  votVoiceless: 0.055, // aspiration after /p t k/ before voicing starts
  votVoiced: 0.012, // after /b d g/
  transition: 0.06, // post-burst move onto the next phoneme
  affricateClosure: 0.07, // how long /tʃ dʒ/ hold closure before self-releasing
  autoReleaseStops: false, // if true, a held stop releases on its own
  maxClosure: 0.25, // ...after this long

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

const TRACT_KEYS = ["ti", "td", "fi", "fd", "bi", "bd"];

export function lerpPose(a, b, t) {
  t = Math.max(0, Math.min(1, t));
  const out = {};
  for (const k of ["ti", "td", "fi", "fd", "bi", "bd", "v", "a"]) {
    out[k] = a[k] + (b[k] - a[k]) * t;
  }
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
 * @param {string} ipaString  e.g. "hɛˈloʊ wɝld" (spaces become silent cells)
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
      cells.push(makeSilence(wordIndex, cfg));
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
      cells.push(makeSilence(wordIndex, cfg));
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

  resolveInheritance(cells);
  return cells;
}

function makeSilence(wordIndex, cfg) {
  return {
    ipa: "·",
    cls: "silence",
    wordIndex,
    width: 0.5,
    voiced: false,
    closes: false,
    blendIn: true,
    blendOut: true,
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
    width: 1,
    example: info.example || "",
    stress: 0,
    closes: false,
    autoRelease: false,
    blendIn: true,
    blendOut: true,
    poses: [],
    releasePose: null,
  };

  switch (cls) {
    case "stop": {
      const closure = cons[0];
      const release = cons[1] || cons[0];
      cell.closes = true;
      cell.blendIn = false;
      cell.blendOut = false;
      cell.poses = [
        pose(closure, voiced ? cfg.voicenessVowel : 0.05, voiced ? cfg.closureIntensityVoiced : 0),
      ];
      cell.releasePose = pose(release, voiced ? 0.85 : 0.02, cfg.burstIntensity);
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
      cell.poses = [
        pose(closure, voiced ? cfg.voicenessVowel : 0.05, voiced ? cfg.closureIntensityVoiced : 0),
      ];
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

/** fill in unspecified articulators by carrying the previous shape forward */
function resolveInheritance(cells) {
  const all = [];
  cells.forEach((cell) => {
    cell.poses.forEach((p) => all.push(p));
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
    const src = next.poses[0];
    cell.poses = cell.poses.map((p) => withTract(p, src));
  });
}

/* ------------------------------------------------------------------ *
 *  the voice
 * ------------------------------------------------------------------ */

export class ScanVoice {
  /**
   * @param {object} params  AudioParams: tongueIndex, tongueDiameter,
   *   frontIndex, frontDiameter, backIndex, backDiameter, tenseness, loudness,
   *   intensity, frequency, tractLength
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

  _ramp(param, value, now, time) {
    if (!param) return;
    if (!isFinite(value)) return;
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
    for (const key in vals) this._ramp(this.params[key], vals[key], now, time);
    this.lastPose = p;
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
    steps.forEach(({ t, pose: p }) => {
      const vals = this._poseValues(p);
      const when = now + Math.max(0.001, t);
      for (const key in vals) this._at(this.params[key], vals[key], when);
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
    return c && (c.released && c.sustainPose ? c.sustainPose : c.poses[0]);
  }

  endPose(i) {
    const c = this.cells[i];
    if (!c) return null;
    if (c.cls === "affricate" && c.sustainPose) return c.sustainPose;
    return c.poses[c.poses.length - 1];
  }

  /** the articulation implied by a continuous position, ignoring stops */
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

  entryPose(i) {
    const cell = this.cells[i];
    if (!cell) return this.lastPose;
    return cell.poses[0];
  }

  fireClosure(i, now) {
    const cell = this.cells[i];
    const target = cell.poses[0];
    this.scheduleGesture(
      [{ t: this.cfg.closeTime, pose: target }],
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
  }

  /**
   * The burst. Fixed duration regardless of how fast the pointer is moving:
   * closure -> pressure -> open + noise -> VOT/aspiration -> next phoneme.
   */
  fireRelease(fromIndex, toIndex, now, { toSilence = false } = {}) {
    const from = this.cells[fromIndex];
    const cfg = this.cfg;
    const closure = from.poses[0];
    const rel = from.releasePose || closure;
    const voiced = from.voiced;
    const vot = voiced ? cfg.votVoiced : cfg.votVoiceless;

    let target;
    if (toSilence) {
      target = Object.assign({}, rel, { a: 0, v: rel.v });
    } else if (from.cls === "affricate") {
      target = from.sustainPose || rel;
    } else {
      const toCell = this.cells[toIndex];
      target = toCell ? toCell.poses[0] : Object.assign({}, rel, { a: 0 });
    }

    // pressure: still closed, but the glottal source is already on
    const pressure = Object.assign({}, closure, {
      a: voiced ? Math.max(closure.a, 0.5) : cfg.burstIntensity * 0.9,
      v: voiced ? 0.85 : 0.02,
    });
    // burst: constriction snaps open, full noise
    const burst = Object.assign({}, rel, {
      a: cfg.burstIntensity,
      v: voiced ? 0.85 : 0.02,
    });
    // aspiration window: tract already moving toward the target, voicing off
    const aspirate = Object.assign({}, lerpPose(rel, target, 0.55), {
      v: voiced ? 0.85 : 0.05,
      a: Math.max(0.6, target.a),
    });

    const steps = [
      { t: 0.001, pose: pressure },
      { t: cfg.burstTime, pose: burst },
      { t: cfg.burstTime + vot, pose: aspirate },
      { t: cfg.burstTime + vot + cfg.transition, pose: target },
    ];
    const lock = cfg.burstTime + vot + cfg.transition;
    this.scheduleGesture(steps, now, lock, "burst", from);

    // the transient itself, fired exactly as the closure lets go
    if (cfg.burstLevel > 0 && !this.whisper) {
      this._pulse(
        this.params.burst,
        cfg.burstLevel * (voiced ? 0.6 : 1),
        now + Math.max(0.002, cfg.burstTime - 0.002)
      );
    }

    from.released = true;
    this.released = true;

    const toCell = this.cells[toIndex];
    if (!toSilence && toCell && toCell.closes) {
      // released straight into another stop: it is closed again at the end
      this.closed = true;
      this.closedAt = now + lock;
      this.released = false;
      toCell.released = false;
    } else {
      this.closed = from.cls === "affricate" ? false : false;
    }
    this.curCell = toSilence ? fromIndex : toIndex;
  }

  enterCell(i, now) {
    const prev = this.cells[this.curCell];
    const next = this.cells[i];
    if (!next) return;

    if (prev && prev.closes && this.closed && !this.released) {
      this.fireRelease(this.curCell, i, now);
      return;
    }
    if (next.closes) {
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

    // affricates let go of their own closure after a moment and sustain
    if (cell.closes && this.closed && !this.released) {
      const held = now - this.closedAt;
      if (cell.autoRelease && held >= this.cfg.affricateClosure) {
        this.fireRelease(i, i, now);
        return;
      }
      if (this.cfg.autoReleaseStops && held >= this.cfg.maxClosure) {
        this.fireRelease(i, i, now, { toSilence: false });
        this.curCell = i;
        return;
      }
      return; // hold the closure: silent, or a voice bar
    }

    this.applyPose(this.poseAtPosition(pos), now, this.cfg.smooth);
  }

  /* ---------------- outside control ---------------- */

  setGate(on, now) {
    const wasOn = this.gate > 0;
    this.gate = on ? 1 : 0;
    if (!on) {
      const cell = this.cells[this.curCell];
      if (cell && cell.closes && this.closed && !this.released) {
        this.fireRelease(this.curCell, this.curCell, now, { toSilence: true });
        return;
      }
      this._ramp(this.params.intensity, 0, now, this.cfg.release);
      this.lockUntil = now + this.cfg.release;
    } else if (!wasOn) {
      this.lockUntil = 0;
      this.curCell = -1; // re-enter, so landing on a stop closes properly
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
    const stress = this.cells[this.curCell]
      ? this.cells[this.curCell].stress * this.cfg.stressSemitones
      : 0;
    return 440 * Math.pow(2, (this.note + this.bend + stress - 69) / 12);
  }

  setTractLength(length, now) {
    this.tractLength = Math.max(15, Math.min(88, length));
    this._ramp(this.params.tractLength, this.tractLength, now, 0.05);
    this.applyPose(this.lastPose, now, 0.05);
  }

  setWhisper(on, now) {
    this.whisper = !!on;
    this.applyPose(this.lastPose, now, 0.05);
  }
}
