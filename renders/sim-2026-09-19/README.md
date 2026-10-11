# Tract — simulated run, 19 Sep 2026

A machine reading of the whole piece: eight players, all 39 cues, the projection
recorded with it. It is a **structural** run — the point is length, density and
the shape of the arc, not interpretation.

- `tract-sim-2026-09-19.mp4` — 5:30, the stage projection with the mixdown
- `tract-mixdown.m4a` — the mix alone (256 kbps)
- `stem-<part>-<seat>.flac` — the eight stems, lossless, mono 44.1 kHz

Everything shares one clock: **sample 0 of every stem is the same instant**, and
video time is that same clock, so the stems drop into a session at 0:00 with no
nudging.

## Timing

Cue 1 at 0:02, and the whole cue sheet is run at **0.70×** the durations in my
reading of your instructions — that is what brings it to 5:27 rather than 7:47.
Phrase entries:

| | | |
|---|---|---|
| 0:08 | cue 2 | words strain |
| 1:02 | cue 8 | CRACK |
| 1:44 | cue 13 | and sometimes break under the burden |
| 2:27 | cue 18 | under the tension |
| 2:47 | cue 21 | slip, slide, perish |
| 3:31 | cue 26 | decay with imprecision |
| 3:58 | cue 29 | will not stay in place |
| 4:28 | cue 33 | will not stay still |
| 5:16 | cue 39 | diminuendo, 8 s |

The parts enter in turn over the first 35 seconds: I at 0:08, II at 0:15,
III at 0:25, IV at 0:35.

## What was ignored, and what was not

- **Presets: ignored.** The run used an empty `presets.json`, so every phrase
  starts from the defaults rather than from your half-finished presets.
- **Pitch drift and wobble: off, on every phrase.** `applyPreset` resets every
  default on each phrase change, so each player re-asserts `vibratoDepth = 0`
  and `wobble = 0` twice a second. Nothing in the run wavers.
- Everything else is the real code: the real cue sheet, the real parts file,
  the real engine, the real stage page. The players are synthetic only in the
  sense that their keystrokes and pointer moves come from a script.

## How it was made

Eight live Pink Trombone worklets do not fit on two cores, so the run was done
in four passes of two players against a fixed timeline — every pass got the same
wall-clock downbeat, which is why the stems line up. The projection was rebuilt
afterwards by replaying the tract frames the players actually streamed into the
real stage page, on the same clock.

## Caveats

- The video is effectively ~8 fps of distinct frames, padded to 25. Motion is a
  little steppy; nothing is missing.
- No player is listening to any other, so nothing here reflects the ensemble
  behaviour the score asks for — the parts are only as together as the clock.
- My reading of the cue instructions is one reading. Where a cue says something
  like "gradually", I picked a rate.

---

## Postscript: this is the drifting take

The pitch in this run is not straight, and that was a bug — the performer sent
`/scan/vibratoDepth` and `/scan/wobble`, which are not addresses the page
listens for (`applyRemote` drops anything it does not recognise, silently). So
every voice ran the stock defaults for the whole five and a half minutes: 6 Hz
vibrato at depth 0.005, plus `wobble: 1`, which re-enables upstream's two
simplex drifts — up to about ±110 cents of slow wander.

Kept on purpose: Jason wanted it as the far end of the pitch-coherence range.
The straight-tone version is in `sim-2026-09-19-straight/`.
