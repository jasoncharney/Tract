# Tract — simulated run, straight tone

Audio only, 6:13. Same eight players, same 39 cues, same reading of the score as
`sim-2026-09-19/` — but with the pitch actually held, and stretched from 0.70×
to **0.80×**.

- `tract-mixdown.m4a` — the mix (256 kbps)
- `stem-<part>-<seat>.flac` — the eight stems, lossless, mono 44.1 kHz

Sample 0 of every stem is the same instant, so they drop into a session at 0:00
with no nudging.

## The pitch

The drifting run sent `/scan/vibratoDepth` and `/scan/wobble`, which are not
addresses the page listens for — `applyRemote` drops an unknown address without
a word, so the stock vibrato and wobble ran for the whole take. The correct
addresses are `/scan/vibrato/depth` and `/scan/vibrato/wobble`, and both are
held at 0 here, re-asserted twice a second because `applyPreset` resets every
default on each phrase change.

Measured on part I, frame to frame at 40 ms, octave errors folded out:

| | median | 90th pct |
|---|---|---|
| drifting run | 40.6 ¢ | 93.2 ¢ |
| this run | **0.0 ¢** | 15.4 ¢ |

The 15 cents at the 90th percentile is composed movement — the score's own note
changes and consonant transitions — not wander.

The four parts now sit where they were written: roughly 116, 110, 98 and 82 Hz
at the opening.

## Timing at 0.80×

| | | |
|---|---|---|
| 0:09 | cue 2 | words strain |
| 1:10 | cue 8 | CRACK |
| 1:58 | cue 13 | and sometimes break under the burden |
| 2:48 | cue 18 | under the tension |
| 3:10 | cue 21 | slip, slide, perish |
| 4:01 | cue 26 | decay with imprecision |
| 4:32 | cue 29 | will not stay in place |
| 5:06 | cue 33 | will not stay still |
| 6:00 | cue 39 | diminuendo, 8 s |

The cue lengths themselves are my reading of your 39 instructions, not anything
written in the score — a cue that asks for one short burst got 5–6 seconds, a
slow pointer sweep across a line got 16. They sum to 7:44; 0.80× brings that to
6:13.

## Still ignored

Presets — the run used an empty `presets.json`, so every phrase starts from the
defaults. Everything else is the real cue sheet, parts file, engine and page.

No projection was rendered for this one.
