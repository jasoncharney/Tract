# scan — a scannable Pink Trombone

A hover-scannable phoneme strip for `zakaton/pink-trombone-demos`. Drop the two
folders (`scan/` and `scan-bridge/`) into the root of your clone.

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

Type words (or IPA) and you get a strip of phoneme cells. Move across it and it
speaks. Where you are is *what* is being articulated; how fast you move is *how
fast* it is articulated. Two rules do the work, and which one applies is decided
per boundary:

**Continuants scan with your hand.** Vowels, nasals, fricatives, approximants —
the tract interpolates with the pointer. Dwell in the middle of a cell and it
holds that shape forever. Crawl across the `o → w` boundary and you hear the
glide take as long as you took. The `transition zone` slider sets how much of a
cell width is spent transitioning versus holding.

**Stops are ballistic.** A stop is a closure plus a burst, and those want
opposite timing. So the closure is held as long as you sit on the cell — silent
for `p t k`, a low voice bar for `b d g` — and the moment you leave, the release
fires on its own clock: burst → VOT/aspiration → onset of the next phoneme,
*the same duration whether you crossed the boundary in 20 ms or 2 seconds*. That
is the part that cannot be done by interpolating presets, and it is why stops
stay intelligible at any scan speed. Affricates (`tʃ dʒ`) are the hybrid: they
close, let go by themselves after `affricate hold`, and then sustain their
frication for as long as you stay.

Leaving the strip releases (a stop still gets its burst on the way out). `h`
takes the shape of whatever follows it, which is what /h/ actually is.
Diphthongs written as two targets glide across their own cell, so you scan
through them too.

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

`scan/src/patched-pink-trombone.js` fixes this without touching anything on
disk: it fetches both upstream files as text, patches them in memory, and
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

The header pill shows how many patches applied. If upstream ever changes and one
fails to match, it says so rather than silently sounding wrong.

---

## Control from Max

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

Names accepted by `/scan/param`: `closeTime`, `burstTime`, `burstLevel`,
`votVoiceless`, `votVoiced`, `transition`, `affricateClosure`, `smooth`, `blend`,
`glide`, `autoReleaseStops`, `maxClosure`, `closureIntensityVoiced`,
`voicenessVowel`, `voicenessVoicedFric`, `voicenessVoicelessFric`,
`stressSemitones`.

Feedback comes back on **7401** — `[udpreceive 7401]`:

```
/scan/out/cell 4 "ɑ"        whenever the current cell changes
/scan/out/gesture "burst"   close | burst
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

## Recording

`record` taps the master output and writes a `.wav` when you stop. Useful for
keeping a take of a scan you liked.

---

## Files

```
scan/index.html                     the page
scan/src/engine.js                  the articulation engine (no DOM, no audio API)
scan/src/patched-pink-trombone.js   the in-memory worklet repair
scan/src/scan.js                    audio setup, strip UI, transports
scan-bridge/scan-bridge.js          static server + WebSocket + OSC/UDP
scan-bridge/scan-control.maxpat     Max control patch
```

`engine.js` is deliberately free of DOM and Web Audio calls beyond AudioParam
scheduling, and is driven by an explicit clock (`voice.update(position, now)`),
so it can be reused anywhere — including a straight `[node.script]` host if you
ever want the synthesis elsewhere.

Options: `node scan-bridge/scan-bridge.js --port 8080 --udp-in 7400 --udp-out 7401
--out-host 127.0.0.1 --root <repo> --verbose`.
