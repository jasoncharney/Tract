# Tract — a scannable Pink Trombone

Jason Charney (2026). A phoneme strip you scan by hand or by key, built on
`zakaton/pink-trombone-demos`, for a four-part laptop-ensemble choir painting
text from Eliot's *Four Quartets*.

```
node scan-bridge/scan-bridge.js
open http://localhost:8080/scan/     # Chrome; click "enable audio"
```

The bridge is a single dependency-free node script. It serves the repo over HTTP
(the demos use absolute paths like `/src/utils.js`, and the AudioWorklet needs a
real origin), runs a WebSocket server on the same port for the page, listens for
OSC on UDP **7400**, and sends feedback back out on UDP **7401**.

---

## How it behaves

Pick one of the eight phrases and you get a strip of phoneme cells. **Hold the
mouse down** and move across it to speak; release, or leave the strip, and the
gate closes. Where you are is *what* is being articulated; how fast you move is
*how fast* it is articulated. Two rules do the work, and which one applies is
decided per boundary:

**Continuants scan with your hand.** Vowels, nasals, fricatives, approximants —
the tract interpolates with the pointer. Dwell in the middle of a cell and it
holds that shape forever. Crawl across the `o → w` boundary and you hear the
glide take as long as you took. The `transition zone` slider sets how much of a
cell width is spent transitioning versus holding.

**Stops are ballistic**, and they come in two kinds depending on where they fall
in the word.

**Stops get no block of their own.** There is nothing in a stop to dwell on, so
each one is folded onto a neighbouring block and drawn in orange on its front or
its back: an *onset*, fired the moment you arrive at that block, or a *coda*,
fired as you reach the end of it. "crack" is two blocks wide — `[k]ɹ` and `æ[k]`
— so a scan at a constant rate never sits waiting in silence for a consonant to
finish. A stop goes on the front of the next thing in its word if there is one,
and on the back of the previous thing otherwise, which is ordinary
syllabification: the `t` of "not" rides the `ɑ`, the `p` of "place" rides the `l`.

The gesture itself is unchanged and still ballistic — closure → burst →
VOT/aspiration → onset of whatever comes next, *the same duration whether you
crossed in 20 ms or 2 seconds*. That fixed clock is the part that cannot be done
by interpolating presets, and it is why stops stay intelligible at any scan
speed. `codaAt` sets how far into a block its trailing stop fires (0.86 by
default, so it lands near the end), and a coda that never got there still fires
when the gate closes, so stopping on the vowel of "crack" still gives you the k.

Turning on **word-final stops wait to be left** goes back to an earlier
behaviour: a word-final stop then keeps a block of its own and holds its closure
(silent for `p t k`, a low voice bar for `b d g`), bursting only when you leave
the word, lift the mouse or close the gate.

Affricates (`tʃ dʒ`) are the hybrid: they close, let go by themselves after
`affricate hold`, then sustain their frication for as long as you stay.

**Word gaps close the gate.** Scanning between words is a real silence and a
fresh attack, not a crossfade, so a held final stop releases into the gap.

`h` takes the shape of whatever follows it, which is what /h/ actually is.
Diphthongs written as two targets glide across their own cell, so you scan
through them too.

## Playing it from the keyboard

The mouse is one way in; the keys are the other, and they need no trackpad
gymnastics. Left hand only:

| key | |
| --- | --- |
| **A** | hold to scan slowly — a fresh 4–6 s drawn for each phoneme |
| **S** | hold to scan at a middle rate — 0.5–1 s per phoneme |
| **D** | hold to scan near speaking tempo — 0.25–0.75 s per phoneme |
| **W E R** | one-shot: play the whole next word, slow / mid / speaking |
| **Q** | one-shot: a random phoneme from the phrase |
| **T** | one-shot: a random stop or fricative, unvoiced — percussion |
| **1**–**8**, **↑ ↓** | choose the phrase |
| **Home** | back to the start of the phrase |

A held key advances the position by itself and closes the gate when you let go —
*keeping the position*, so pressing again carries on from where you stopped
rather than restarting the phrase. Run off the end and the next press starts
again from the beginning. The per-phoneme duration is redrawn for every cell, so
two players on the same part holding the same key will drift apart, which is the
point.

The three ranges are the `RATES` block at the top of `scan/src/scan.js`, marked
with a comment — seconds per phoneme, `[minimum, maximum]`, one line each. A
cell's width scales its share: a stop's narrow cell takes half as long as a
vowel, a word gap about two thirds.

While a key is scanning it owns the position: moving the trackpad does nothing,
so a stray cursor cannot yank you into the middle of another word. Pressing the
strip deliberately takes over and cancels the key.

**W E R** walk through the phrase word by word, or pick a word at random —
that is per phrase, set in the composer presets below. **T** forces the voice
unvoiced for the length of the hit and hands it back afterwards, so a `k` is a
click and an `s` is a hiss whatever the pitch is doing.

## The four parts

Pick a part in the header. There is **no transposition** — a part does not shift
a written pitch. Instead each part's entry for each phrase lists the pitches that
part may use, and those are the keys that light up on the piano. The player
chooses among them by clicking a chip or the key itself. Two parts can perfectly
well share a pitch, and the last phrase has all four in unison.

```json
{
  "id": "1", "name": "Part 1", "tractDelta": -6,
  "phrases": [
    { "notes": ["Eb3", "G3"], "instruction": "enter first, on either pitch…" },
    …one entry per phrase…
  ]
}
```

Pitches can be names (`Eb3`, `G#4`, `A 2`) or MIDI numbers, and **fractional
numbers work**: `51.5` is a quarter-tone, and the app labels it `E3 −50¢` rather
than pretending it is a semitone. An empty `notes` list frees the pitch
entirely — the chips then read "any pitch". Changing phrase moves you to the
first pitch of the new list, unless the one you are on is still allowed, in which
case you keep it.

What a part *does* carry is a body: `tractDelta` is added to the phrase preset's
tract length, so the lower parts sound larger as well as lower. The defaults run
−6, −2, +2, +8. Nothing about the parts is SATB; they are Part 1 to Part 4 and
you can rename them.

All of it lives in `scan/parts.json`, which is meant to be edited by hand as you
compose. The instruction lines are also editable in the app with `?composer=1`,
with an **export parts.json** button beside the preset one. Every instruction in
the file right now is placeholder text, and the pitch sets are a sketch — a
descending harmonic field over the eight phrases, quarter-tones for "decay with
imprecision", unison for the last.

The pitch chosen is not enforced: clicking an unlit key still works, on the
assumption that the instruction line is the authority and a player may need to
get out of trouble. Say if you would rather it were locked.

## The phrases

Eight fixed phrases, stepped with the `‹ ›` buttons, the dots, `↑`/`↓`, or the
number keys `1`–`8`:

1. words strain
2. CRACK
3. and sometimes break under the burden
4. under the tension
5. slip, slide, perish
6. decay with imprecision
7. will not stay in place
8. will not stay still

A comma earns a second gap cell, so the breath in "slip, slide, perish" is
longer than an ordinary word gap. Where the dictionary offers more than one
pronunciation for a word, a menu appears at the top of *timing & voice*, with a
mode beside it: **as chosen**, **re-roll each phrase**, or **re-roll each word**.
The second re-draws every variable word whenever the phrase is triggered; the
third re-draws a single word each time that word is triggered — by W/E/R, or by a
scan crossing into it. The chosen variants and the mode are both stored in the
phrase preset, so you can audition and keep them. "imprecision" is
not in the CMU dictionary at all; its IPA is supplied in `scan.js`, built from
the dictionary's own "precision". Anything outside the list can still be sent
from Max with `/scan/text` or `/scan/phonemes`.

---

## The burst — what was wrong upstream

This matters if you have been fighting the same thing in Max.

Pink Trombone models a plosive burst as a *transient*: an impulse injected into
the waveguide at the point of closure. In this build that transient can never
fire. Three faults, all in `pink-trombone-worklet-processor.min.js`:

1. `Tract._updateTract()` never resets `transients.obstruction.new` to `-1`, so
   once the tract has closed anywhere it counts as obstructed forever and the
   release test (`obstruction.new == -1`) is never true.
2. Even when it is, it pushes `new Transient(obstruction.new)` — position `-1` —
   instead of `obstruction.last`, where the closure actually was. Writing to
   `float64Array[-1]` is a silent no-op.
3. `Transient.amplitude` returns `strength * Math.pow(-2, timeAlive * exponent)`.
   A negative base with a fractional exponent is `NaN`, which would poison the
   tract (there is an `isNaN` guard that resets it). Upstream Pink Trombone
   decays as `strength * Math.pow(2, -exponent * timeAlive)`.

So no matter how well you interpolate the articulators from outside — a VST,
OSC, keyframes — the click that makes a stop a stop is simply absent. You get the
formant transitions and none of the release.

`scan/src/patched-pink-trombone.js` fixes this (and the vibrato drift described
above) without touching anything on disk: it fetches both upstream files as text, patches them in memory, and
imports them as blob modules. Load the page with `?nopatch=1` to A/B against the
unmodified synth.

It does **not** simply re-enable the automatic transient. Measured, that fires
off tract *geometry*, and a constriction that slides into place while narrowing
momentarily closes and re-opens — you get a loud spurious click every time you
arrive at a stop. Instead the patch adds a new AudioParam, `burst`: a rising edge
fires exactly one transient at the narrowest point of the tract, with its
strength scaled by the parameter. The engine fires it at the instant it opens the
closure. The burst is a scheduled musical event with a level control, not a side
effect. (The two obstruction bugs are deliberately left alone, which keeps the
automatic path inert.)

### One more, in this repo's own code

`newConstriction()` marks a constriction as taken only after a message
round-trip to the worklet, so two synchronous calls hand back **the same
constriction**. The front and back constrictions were therefore one object, and
every frame scheduled two conflicting ramps onto one pair of parameters — the
tract twitching visibly and clicking audibly even with nothing moving, since the
tracking loop keeps writing after the gate closes. Measured with the position
held still, the constriction index swung over a range of 8 and the diameter over
4. Claiming each constriction immediately fixes it; the parameters are now
exactly static when nothing moves.

Worth knowing if you go back to the upstream demos: `pink-trombone/src/script.js`
makes the same two calls, so its front and back constrictions are the same one
too.

A second cause of drift, fixed alongside: the tracking loop re-scheduled every
parameter every frame even when the target had not changed. Sixty
`cancelAndHoldAtTime` calls a second on a parameter that is not moving is pure
churn, and each one can nudge the value. Parameters are now only re-scheduled
when the target actually moves — which is also what makes a wobble of 0 hold an
*exactly* constant pitch.

The header pill shows how many patches applied. If upstream ever changes and one
fails to match, it says so rather than silently sounding wrong.

---

## Control from Max

(The panel describing this is hidden unless you open the page with
`?composer=1` — the piece needs no Max.)

`scan-bridge/scan-control.maxpat` is a working patch. Max's `[udpsend]` sends OSC
automatically for any message beginning with `/`.

```
[udpsend 127.0.0.1 7400]
```

| message | meaning |
| --- | --- |
| `/scan/position 3.42` | scan position in cell units (index + fraction) |
| `/scan/norm 0.5` | same, normalised 0.–1. across the whole strip |
| `/scan/index 3` | jump to the centre of cell 3 |
| `/scan/gate 1` \| `0` | sound / release. `0` releases a held stop properly |
| `/scan/phrase 3` | choose phrase 1–8 |
| `/scan/next`, `/scan/prev` | step through the phrases |
| `/scan/note 60.5` | **pitch as a MIDI note number**, fractional welcome |
| `/scan/bend -2.` | semitone offset on top |
| `/scan/glide 0.05` | portamento, seconds |
| `/scan/text "hello world"` | set the words (quotes keep it one symbol) |
| `/scan/phonemes tɑdɑsi` | set IPA directly |
| `/scan/speed 1.5` | scale every gesture constant at once |
| `/scan/param burstTime 0.012` | set any single timing constant by name |
| `/scan/tract 52` | tract length, 15–88 |
| `/scan/whisper 1` | voiceless throughout |
| `/scan/gain 0.9` | output level |
| `/scan/vibrato/rate`, `/scan/vibrato/depth`, `/scan/vibrato/wobble` | |

Names accepted by `/scan/param`: `closeTime`, `passClose`, `burstTime`, `burstLevel`,
`votVoiceless`, `votVoiced`, `transition`, `affricateClosure`, `smooth`, `blend`,
`glide`, `autoReleaseStops`, `maxClosure`, `retriggerLockout`, `closureIntensityVoiced`,
`voicenessVowel`, `voicenessVoicedFric`, `voicenessVoicelessFric`,
`stressSemitones`.

Feedback comes back on **7401** — `[udpreceive 7401]`:

```
/scan/out/cell 4 "ɑ"        whenever the current cell changes
/scan/out/gesture "burst"   close | burst | stop | gap
/scan/out/phrase 3 "..."    whenever the phrase changes
```

Fractional note numbers mean your microtonal tables drive it directly: send
`60.`, `60.5`, `60.72` and it tracks. Pitch is applied with `linearRampToValueAtTime`
over `glide`, so send a stream of values for a portamento line.

### Other ways in, if you would rather not run the bridge

* **jweb** — the page binds `window.max.bindInlet` for `position`, `norm`,
  `index`, `gate`, `note`, `bend`, `text`, `phonemes`, `param`, `speed`, `tract`,
  `whisper`, `gain`, exactly like the karaoke display. AudioWorklet inside jweb's
  WebKit view is the risk; it works in Chrome for certain.
* **Web MIDI** — note on sets the pitch and opens the gate, note off releases,
  pitch bend maps to ±2 semitones, CC 1 scans the strip.
* **BroadcastChannel** — messages addressed `to: ["scan"]` on the `pink-trombone`
  channel, so the other demos in this repo can drive it.
* **Raw JSON over UDP** — a datagram starting with `{` is forwarded verbatim:
  `{"address":"/scan/position","args":[3.4]}`.

---

## Notes on the tract view

The upstream Pink Trombone view draws a 600×500 canvas with `position: absolute`
inside a grid that reserves no room for it, so left alone it spills down the page
over everything below. The panel here clips it and hides the glottis and button
sub-panels, keeping the tract itself.

## The piano

The strip under the readout sets the pitch: click a key and the voice moves
there, and it follows the pitch slider and `/scan/note` the other way, so
whatever sets the pitch, the keyboard shows it. Fractional MIDI notes still
work — the piano highlights the nearest key and the label gives you the exact
value and frequency.

## Vibrato, and singing without it

`vibrato rate` and `vibrato depth` are the periodic vibrato; `wobble` is the
slow random drift. Set both depth and wobble to 0 and the pitch is genuinely
steady: measured over two seconds, 2 cents of standard deviation. That needs the
`steady-pitch` patch, because the glottis otherwise adds two unconditional
simplex drifts that no parameter turns off.

## Composer presets

Open the page with `?composer=1` and a row appears at the top of *timing &
voice*: save the current settings to the current phrase, revert, clear, choose
whether **W E R** take the next word or a random one, and export. Presets cover
every timing constant plus pitch, tract length, output, vibrato and whisper, and
they are applied automatically when you change phrase.

They live in two places. Anything you save goes to this browser's local storage,
which is what you want while tuning. `export presets.json` downloads the lot;
commit it as `scan/presets.json` and it ships with the piece, so the players get
your settings without touching anything. Local storage wins over the committed
file, so your own machine keeps whatever you were last working on — clear it
with `?composer=0` and the browser's site data if you want to hear exactly what
the players will.

The *timing & voice* sliders themselves stay visible for everyone; only the
preset row is hidden.

## The burst, and how to shape it

Three controls in *timing & voice*:

* **burst strength** — how much impulse is injected at the closure.
* **burst brightness** — how fast that impulse decays, 50 to 2000. Higher is
  shorter and brighter; lower is longer and boomier. At the default 500 a /t/
  burst measures a spectral centroid around 1.2 kHz; at 200 it drops to 650 Hz
  and starts to sound like a balloon popping.
* **pressure behind p t k** — how much source is running behind the closure
  before it opens. Whatever is behind a closed tract is trapped and escapes as a
  thump, so this is the other half of the pop.

The injection itself had a fault worth knowing about: this build adds the
transient only to the leftward line of the waveguide, at full amplitude, where
upstream Pink Trombone splits it half and half between both directions. That
one-sided shove is a large low-frequency imbalance. Split, a /t/ burst moves from
a 497 Hz centroid with 19 dB more energy below 500 Hz than above 1.5 kHz, to a
1.2 kHz centroid with 1.5 dB *less*, and its peak drops by about 14 dB. The
`transient-balance` patch does this.

## Level

The raw tract peaks around +18 dBFS with a 27 dB crest factor — the bursts are
genuinely far above the average, as they are in speech. The output runs through
a compressor and then a tanh soft-clip, because a burst transient is a
sample-level impulse and no compressor attack is fast enough for it. At the
default output of 0.4 a phrase peaks around −3 dBFS with the soft-clip never
engaging. (If you saved presets before this change, their stored output level
will be far too hot — re-save them.)

## Recording

`record` taps the master output and writes a `.wav` when you stop. Useful for
keeping a take of a scan you liked.

---

## Files

```
scan/index.html                     the page
scan/src/engine.js                  the articulation engine (no DOM, no audio API)
scan/src/patched-pink-trombone.js   the in-memory worklet repair
scan/src/scan.js                    audio setup, strip UI, keyboard transport, transports
scan/presets.json                   per-phrase settings that ship with the piece
scan-bridge/scan-bridge.js          static server + WebSocket + OSC/UDP
scan-bridge/scan-control.maxpat     Max control patch (optional — the piece needs no Max)
```

`engine.js` is deliberately free of DOM and Web Audio calls beyond AudioParam
scheduling, and is driven by an explicit clock (`voice.update(position, now)`),
so it can be reused anywhere — including a straight `[node.script]` host if you
ever want the synthesis elsewhere.

Options: `node scan-bridge/scan-bridge.js --port 8080 --udp-in 7400 --udp-out 7401
--out-host 127.0.0.1 --root <repo> --verbose`.
