# Tract — working notes for Claude

**[README.md](README.md) and [scan/README.md](scan/README.md) are the real
documentation.** Read scan/README.md before changing anything in `scan/`. This
file is only the things those two do not say: conventions, and facts that were
established by measurement and are expensive to rediscover.

## Running it

```
node scan/scan-bridge.js          # serves the repo, WebSocket + OSC on one port
```

Then `https://localhost:8080/` (player), `/conduct.html` (desk),
`/stage.html` (projection). No build step, no install, no dependencies —
`node` and a browser are the whole toolchain. Node's own `--check` is the lint.

## The pieces

| | |
| --- | --- |
| `scan/src/scan.js` | the player's page — the strip, the synth, keys, MIDI, cues |
| `scan/src/engine.js` | the voice: gating, pitch, the plosive burst timing |
| `scan/src/conduct.js` | the conductor's desk — cue transport, roster, playhead strips |
| `scan/src/stage.js` | the projection — the wall of tracts, subtitles, title card |
| `scan/scan-bridge.js` | static HTTPS + WebSocket relay + OSC bridge, dependency-free |
| `scan/cues.json` `parts.json` `presets.json` | the score, written by the pages themselves |
| `midi/make-midi.js` | the piece as 8 MIDI tracks, for working out timing, from `midi/timing.json` (a hand-written reading of every cue) |
| `score/make-score.js` | the printed guide, player cards and cue sheet |

## Conventions

- **Dependency-free on purpose.** The bridge, the generators and the pages use
  nothing but Node and the browser. Don't add a package to solve something a
  dozen lines can do.
- **Comments say *why*, not what.** Most of the long comments in this codebase
  record a measurement or a trap. Keep that habit; a comment stating a number
  should be a number someone measured.
- **Upstream is patched in memory**, never forked: fetch → string replace →
  blob module import. `?nopatch=1` on the player A/Bs it.
- **Verify against the running thing.** Claims about audio, geometry or layout
  in this project have a history of being wrong when reasoned about and right
  when measured. `test/` drives the real pages headlessly and measures what
  comes out — see `test/README.md` for what that has caught. Run it before and
  after a change:

  ```
  cd test && npm run setup     # once
  node test/run-all.js         # ~110s, 164 checks, 6 suites
  node test/play-midi.js       # ~6 min, after touching midi/: the file played into pages
  node test/run-all.js stage   # just the matching ones
  ```

  Add to the suite that fits rather than starting a new one, and put the
  measured value in `t.check`'s third argument even when it passes. A check
  that passes while proving nothing is the failure mode: one here once
  asserted a phoneme "was a string" and passed on the empty string the page
  correctly sends for silence.

## Facts that cost time to learn

- **AudioWorklet needs a secure context.** Over plain `http://` to a LAN IP,
  upstream silently falls back to a main-thread ScriptProcessorNode and the NaN
  guard cannot install. This is why the bridge issues its own certificate and
  serves https. The player's header pill reports which path it got.
- **`cancelAndHoldAtTime(now)` does nothing when no automation event exists
  after `now`.** The next ramp then interpolates from a stale anchor. Always
  follow it with an explicit `setValueAtTime(here, now)` — see `_anchor()` in
  engine.js.
- **Intensity → loudness is a square law.** Measured: 0.5 → −12 dB, 0.1 →
  −40 dB, 0.01 → −80 dB. A linear intensity ramp is not a linear fade; the
  release lays segments along an exponential for that reason.
- **The bridge only relays `/cue/`, `/player/`, `/conductor/`, `/stage/` and
  `/tract/`.** `/scan/out/*` goes to OSC/UDP only and never reaches another
  page. Addresses that don't match are dropped silently by a `default: break`,
  so a typo'd address is invisible — check the dispatcher when a message
  "doesn't arrive".
- **Feeds are gated on a listener.** Players send `/tract/frame` only while a
  stage is saying hello, and `/player/at` only while a desk is pinging. A page
  that isn't listening gets nothing, by design.
- **A window not in front gets almost no animation frames**, and a Playwright
  page can never show you that: Playwright turns background throttling off and
  keeps its pages visible. Anything that must keep time — the transport, the
  voice — runs from `step()`, which a worker heartbeat calls when frames stop
  arriving. Painting stays on rAF. To test hidden behaviour, launch the binary
  yourself; see `behindAnotherTab` in `test/midi.test.js`.
- **`MACHINE` is regenerated on every page load** and deliberately not stored.
  It lived in sessionStorage once; browsers copy that into a duplicated tab, so
  three players opened that way all claimed to be one machine.
- **`RATES` (held A/S/D) and `SHOT_RATES` (one-shot W/E/R) are separate.** A
  one-shot can't be released early, so it can't share the hold rates. These get
  tuned by ear — `midi/make-midi.js` reads `RATES` straight out of scan.js
  rather than keeping a copy, and prints what it found.
- **Phrase changes from MIDI are idempotent** (`goToPhrase`). Locating in a DAW
  re-sends the current phrase constantly; without the guard every locate would
  stop a running scan and re-apply its preset under the player.
- **dB(A) is the wrong metric for this piece.** It said the fricatives were
  6.7 dB below the vowels; with critical-band summation they were level with
  them, because a vowel puts its energy in a few bands and a sibilant spreads
  across ten. Anything about perceived balance here has to be measured with
  band summation, not a weighted sum of energy.
- **Noisy consonants have an envelope** (`fricativeSustain` and friends in
  engine.js): full attack, then back to a sustain over a quarter second with
  the decay redrawn each onset. Raise those toward 1 to put the hiss back.
  Intensity drives loudness as a square AND narrows the band spread, so the
  measured drop is roughly twice what the square law alone predicts.
- **Two voices differ by the length of the throat, never by pitch.** Parts
  carry `tractDelta`, seats carry `seatTract()`. Measured: the four parts move
  the spectral centroid 25% and F2 520 cents while all sounding 218.3 Hz — 0
  cents apart. A preset stores the WRITTEN length with neither added, or
  saving would walk the voice one seat further every time.
- **Cell widths are not uniform** (0.5 for a pass-through stop, 1.15 for a held
  one, 0.6 for a gap, 1 otherwise). "Half way through the cells" and "half way
  along the strip" are different places — see `posFraction()`.

## When you change a page

`BUILD` in the `.js` and the `?v=` cache-buster in the `.html` that loads it
must move together, and all three pages should carry the same stamp. A stale
cache-buster means a projector laptop quietly running last month's code;
`stage.html` was left behind at `2026-09-20a` for several builds exactly that
way. Date-based: `2026-10-18b`.

## Two counts that are not the same count

The desk's "N connected" and the wall's tiles answer different questions, and
a gap between them is information, not a bug.

| | fed by | sent | forgotten after |
| --- | --- | --- | --- |
| desk total | `/player/hello` | every 4s, from the open socket | 9s |
| stage tiles | `/tract/frame` | 20/s, **only while `ready`** | 6s |

`ready` needs a click, because browsers will not start audio without one. So a
laptop on the open part-picker, or one opened with `?part=` (which skips the
picker, and so skips the click), is counted and draws nothing. Measured: 7
connected, 6 tiles — exactly the rehearsal report that found it.

The hello also goes out in reply to `/cue/ping`, and a websocket handler is not
timer-throttled where `setInterval` is, so a backgrounded tab can keep
answering the desk after its frame feed has fallen below the wall's 6s. That
part is read off the code, not measured — headless Chrome will not throttle.

`partChosen` is why a page says nothing about its part until a person picks
one: claiming the default part I also took a seat on part I, and `of` is what a
phrase divides its pitches by, so an idle laptop moved other players' pitches.
`test/part-claim.test.js` fails on the old behaviour with `of` reading 3.

## Flags worth knowing

| | |
| --- | --- |
| `?composer=1` | the preset row on the player |
| `?midi` / `?midich=N` | MIDI dev mode — invisible without it, no permission prompt |
| `?IP` / `?IP?network` | stage shows the join address instead of the title |
| `?layout=grid\|ring` | the wall's arrangement; `L` cycles it live |
| `?debug=1` | stage lists every machine feeding it |
| `?nopatch=1` | player, unpatched upstream, for A/B |

## Not yet true in the docs

- `README.md` and `scan/README.md` do not mention: the player's `esc` (stop
  everything), the MIDI dev mode, the stage's `?IP` card, the ring layout, or
  the conductor's per-player playhead strips.
- `test/` is the only thing in this repo with a dependency (Playwright,
  confined to that folder). Nothing in `scan/`, `midi/` or `score/` imports
  from it, and the piece still runs and performs with `node` alone.
