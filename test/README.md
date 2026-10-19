# test

```
cd test && npm run setup      # once: installs Playwright and a Chromium
node test/run-all.js          # from the repo root
node test/run-all.js stage    # only the suites whose name matches
node test/stage-join.test.js  # or one on its own
```

**The piece has no dependencies. These tests do** — Playwright, confined to
this folder, never required to run or perform *Tract*. Nothing in `scan/`,
`midi/` or `score/` imports anything from here.

Each suite starts its own bridge on a free port and its own browser, so they
can be run in any order or on their own. `run-all.js` runs them in series
because several open four or more player pages with the synth going.

## Why they are shaped like this

They drive the real pages and measure what comes out — pixels, computed
styles, bounding boxes, audio levels, parsed MIDI bytes. There are no unit
tests of the arithmetic, because the arithmetic has rarely been the problem.
Things that were caught only by looking at the result:

- the ring layout placed nine players perfectly and overlapped at three, four
  and five — two squares whose centres are `s` apart still overlap on the
  diagonal, and on a wide ellipse the closest pair is not the next one round
- every MIDI file was malformed, because a cue marker contains `·`: one
  JavaScript character, two UTF-8 bytes, so every meta-event length was one
  short
- the phoneme in the crook was clear of the drawing and still looked wrong,
  floating near the corner of the tile
- the join address wrapped onto two lines at its longest, which is worse than
  small type, because people type the first line

A check that passes while proving nothing is the failure mode to watch for.
One here once asserted a phoneme "was a string", sampled it with the gate shut
and passed on the empty string the page correctly sends for silence.

## The suites

| | |
| --- | --- |
| `player-keys` | hold rates against the table in scan.js, one-shot lengths, esc, phrase cancel, whisper |
| `conductor` | names, the strip of playheads, last-sent, next-instruction-before-the-light |
| `stage-layout` | grid and ring at every count 1–20 on two screen shapes, subtitles, the count readout |
| `stage-phoneme` | the phoneme in the crook, in pixels, across the real range of tract widths |
| `stage-join` | `?IP`, the network name, and that none of it leaks into a performance |
| `midi` | the generated files parsed back from the spec, and the note map on a live page |

## Writing another

```js
const { suite } = require("./lib/harness");

suite("what it is", async (t) => {
  const page = await t.player({ part: "II", audio: true });
  t.section("1 — the thing");
  t.check(condition, "what should be true", "what was actually seen");
});
```

`t.player`, `t.freshPlayer` (its own profile, so `localStorage` is empty),
`t.stage`, `t.desk`. Audio is opt-in and costs a second or two plus a lot of
memory — most of what a player does is visible without it, and nine contexts
with AudioWorklets running is a test of the machine rather than of the piece.

Put the measured value in the third argument of `t.check` even when it passes.
Several numbers in these files were worth knowing later.
