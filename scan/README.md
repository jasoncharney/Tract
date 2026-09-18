# Tract — a scannable Pink Trombone

Jason Charney (2026). A phoneme strip you scan by hand or by key, built on
`zakaton/pink-trombone-demos`, for a four-part laptop-ensemble choir painting
text from Eliot's *Four Quartets*.

```
node scan-bridge/scan-bridge.js
open http://localhost:8080                   # a player
open http://localhost:8080/conduct.html      # the conductor
```

The bridge is a single dependency-free node script. It serves the repo over HTTP
(the demos use absolute paths like `/src/utils.js`, and the AudioWorklet needs a
real origin), runs a WebSocket server on the same port for the page, listens for
OSC on UDP **7400**, and sends feedback back out on UDP **7401**. It also accepts
a `PUT` of `scan/presets.json`, `scan/parts.json` and `scan/cues.json` — only
those three paths, only valid JSON, only from the machine running it — which is
how the composer's save buttons write to disk. It listens on every interface, so
the rest of the ensemble can reach it; see **Conducting** below.

---

## How it behaves

Pick one of the eight phrases and you get a strip of phoneme cells — the symbols
live in the cells themselves; the bare IPA transcription that used to sit above
the strip is hidden, so what a player reads is the text and the blocks. **Hold the
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

Once a coda has gone off, its block is spent: the scan can sit on the tail of
"crack" and hear nothing until it leaves. That needed saying in the code, because
the tracking loop's whole job is to keep applying the block's pose — measured, it
slid the voice back into the æ about 80 ms after the k and held it there for as
long as you stayed, which is exactly the ringing you could hear. Scanning back
into the block by more than a tenth of its width arms the stop again, so
back-and-forth re-fires it without chattering on the boundary.

Turning on **word-final stops wait to be left** goes back to an earlier
behaviour: a word-final stop then keeps a block of its own and holds its closure
(silent for `p t k`, a low voice bar for `b d g`), bursting only when you leave
the word, lift the mouse or close the gate.

Affricates (`tʃ dʒ`) are the hybrid: they close, let go by themselves after
`affricate hold`, then sustain their frication for as long as you stay.

**Word gaps close the gate.** Scanning between words is a real silence and a
fresh attack, not a crossfade, so a held final stop releases into the gap.

Each tile carries its symbol and a coloured bar for its class — vowel, stop,
fricative, nasal, approximant. The class is no longer spelled out under the
glyph: "APPR" beneath a letter is a linguistics lesson a player did not ask for,
and the colour already says it. Hovering a tile still names it.

`h` takes the shape of whatever follows it, which is what /h/ actually is.
Diphthongs written as two targets glide across their own cell, so you scan
through them too.

## What a player sees

One screen, no scrolling. On a 1440×900 laptop everything is above the fold with
the tract drawing open — measured, and again at 1280×800 and 1024×768, with a
long two-line instruction in place.

Until a cue arrives — including after stepping through the phrases by hand — every
phrase reads *"Waiting for cues. Make sure your audio output is up and you are
connected to the conductor."* A player who opens the page early is told what to
check, not handed an instruction nobody gave them. (In composer mode the phrase's
own line from `parts.json` shows instead, so it is still editable there.)

**One sentence per line.** An instruction is a list of things to do in order, and
stacked sentences are easier to take in at a glance than a paragraph. The split
happens after `.`, `!` or `?` — plus any closing quote, so `break.'` ends a line —
and it needs whitespace after the stop, which is what keeps `0.25 s` and `Bb2.`
whole. Sentences are split before the text is escaped, so the split can never
land inside a tag.

That makes a long cue taller, so the type gives way rather than the page: the
instruction starts at whatever size the stylesheet asks for and steps down a
pixel at a time until the page stops overflowing, never below 16px. On a 1440×900
screen a five-sentence cue still reads at the full 34px.

The **instruction is the biggest thing on the page**, near the full width, from
34px down to 16px depending on the window; it wraps to a second line rather than
shrinking past 16px, and on a short screen the furniture (tract, piano, strip)
gives up height before the text does. It is a score a player reads at arm's
length with their hands on the trackpad, not a caption.

Under the strip is one line about the mouse, then the piano — the two things a
player actually touches, with nothing between them. The key legend has moved into
a **keys & mouse** panel, folded shut, next to *timing & voice*: with cues naming
their own keys (below) it is a reference, not something to read while playing.
The position/cell/gesture readout lives in there too.

Beside those, the **tract drawing sits side by side** with them. The
drawing is scaled down — upstream lays out a fixed 600×500 canvas with absolutely
positioned parts, so it cannot simply be given a smaller box; it is scaled with a
transform and the panel is sized to what that leaves. The tract opens by itself
when audio starts, and `hide` in its title bar turns it off for a player whose
laptop needs the CPU. *Timing & voice* stays collapsed, because most players will
never open it.

## Playing it from the keyboard

The mouse is one way in; the keys are the other, and they need no trackpad
gymnastics. Left hand only:

| key | |
| --- | --- |
| **A** | hold to scan slowly — a fresh 3–5 s drawn for each phoneme |
| **S** | hold to scan at a middle rate — 0.25–0.75 s per phoneme |
| **D** | hold to scan fast — 0.1–0.25 s per phoneme |
| **W E R** | one-shot: play the whole next word, at those same three rates |
| **Q** | one-shot: a random phoneme from the phrase |
| **T** | one-shot: a random stop or fricative, unvoiced — percussion |
| **Z** | whisper on / off — latching, and it survives **T** |
| **1**–**8**, **↑ ↓** | choose the phrase |
| **Home** | back to the start of the phrase |

A held key advances the position by itself and closes the gate when you let go —
*keeping the position*, so pressing again carries on from where you stopped
rather than restarting the phrase. Run off the end and the next press starts
again from the beginning. The per-phoneme duration is redrawn for every cell, so
two players on the same part holding the same key will drift apart, which is the
point.

While a key is scanning it owns the position: moving the trackpad does nothing,
so a stray cursor cannot yank you into the middle of another word. Pressing the
strip deliberately takes over and cancels the key.

The playback keys also work while a slider or checkbox has focus. Nothing in
*timing & voice* answers the keyboard: a control you just clicked blurs itself,
and the arrow keys and space are claimed by the transport rather than by the
focused slider, so `A S D W E R Q T Z` and `1`–`8` never disappear into a control
you happened to touch. (Only a real text field swallows a keystroke, and the page
has none.) That is plain `keydown` with a tag test — no key-capture tricks, so it
behaves the same in any browser.

### Where the defaults live

Two labelled blocks at the top of `scan/src/scan.js`, both meant to be edited:

* `RATES` — the three key speeds, seconds per phoneme, `[minimum, maximum]`, one
  line each. A cell's width scales its share: a stop's narrow cell takes half as
  long as a vowel, a word gap about two thirds.
* `VOICE` — what the page starts with and what the sliders read on load: `note`,
  `gain`, `tractLength`, and `vibrato: { rate, depth, wobble }`.

`VOICE` is the only place a voice default can usefully be set. The `defaultValue`
fields in `pink-trombone-worklet-processor.min.js` — including `vibratoWobble` —
look like the defaults but are never heard: the page writes every parameter the
moment audio starts, so editing them there does nothing. And a saved phrase
preset overrides `VOICE` in turn, so if a phrase has a preset, that is what you
are hearing; clear or re-save it (composer mode, below) to pick up a new default.

**W E R** walk through the phrase word by word, or pick a word at random —
that is per phrase, set in the composer presets below. **T** forces the voice
unvoiced for the length of the hit and hands it back afterwards, so a `k` is a
click and an `s` is a hiss whatever the pitch is doing.

## The four parts

Opening the page asks which part you are singing before anything else: a modal
over the whole page, four buttons — **I II III IV**, the names and nothing else —
and no way past it but choosing. The choice doubles as the gesture that starts
audio, so a player opens the page, clicks their part, and is ready. It is
remembered, and the remembered one is outlined — but it still has to be
confirmed, because the usual mistake in an ensemble is a laptop quietly left on
yesterday's part. `?part=2`, `?part=II` or `?part=<id>` skips the modal
entirely, which is what you want for a rehearsal machine or a screenshot. The
header selector still changes part mid-piece.

There is **no transposition** — a part does not shift
a written pitch. Instead each part's entry for each phrase lists the pitches that
part may use, and those are the keys that light up on the piano. The player
chooses among them by clicking a chip or the key itself. Two parts can perfectly
well share a pitch, and the last phrase has all four in unison.

```json
{
  "id": "1", "name": "I", "tractDelta": -6,
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
−6, −2, +2, +8. Nothing about the parts is SATB; they are **I**, **II**, **III**
and **IV**, and you can rename them.

All of it lives in `scan/parts.json`, which is meant to be edited by hand as you
compose. The instruction lines are also editable in the app with `?composer=1`,
with a **write parts.json** button beside the preset one. Every instruction in
the file right now is placeholder text, and the pitch sets are a sketch — a
descending harmonic field over the eight phrases, quarter-tones for "decay with
imprecision", unison for the last.

The pitch chosen is not enforced: clicking an unlit key still works, on the
assumption that the instruction line is the authority and a player may need to
get out of trouble. Say if you would rather it were locked.

## Conducting

`scan/conduct.html` is a second page on the same bridge — open it on the
conductor's laptop while the players open `/scan/`. It makes no sound; it reads
`scan/cues.json`, keeps a pointer in the cue list, and lights people up.

**A cue speaks only to the parts written under it.** That is the rule everything
else follows from. A part with no entry in a cue is sent nothing: no instruction,
no prep light, no downbeat flash. So "hold what you are doing" and "there is no
cue for you here" stay different things, which is what lets some passages be
conducted while the players around them are listening to each other and choosing
for themselves.

```json
{
  "cues": [
    {
      "id": "4", "phrase": 2, "label": "CRACK — first",
      "note": "listen: they choose the spacing themselves here",
      "parts": {
        "3": { "instruction": "T on your own. Not together — let them scatter." },
        "4": { "instruction": "T on your own. Not together — let them scatter." }
      }
    }
  ]
}
```

**Name a key in curly brackets and it comes out as a key box**, the same ones as
the legend, sized to the text around it:

```json
{ "instruction": "Hold {A} to scan slowly. {W} {E} {R} play one word. {Home} to restart." }
```

Anything from one to twelve characters between `{` and `}` works — `{A}`, `{↑ ↓}`,
`{Home}` — and everything outside the brackets is escaped, so a cue file stays
text and never becomes markup. The conductor's own panel draws them the same way,
so the desk shows exactly what the players are reading.

`parts` is keyed by the part ids in `parts.json`. `phrase` groups cues under a
heading in the conductor's list and is not sent anywhere — a cue changes what a
player *reads*, never their phrase or their pitch. `label` and `note` are for the
conductor's eyes only; the note is the place for "wait for the room", the things
you would otherwise write on a sticky note on the laptop. Cues need not be evenly
distributed: a phrase can carry six of them or none, and a cue can name one part
or all four.

### The desk

The cue list runs down the right, grouped by phrase, with a chip per part showing
at a glance who each cue touches. Click any cue to move the pointer there;
`›`/`‹` or `→`/`←` step. The panel on the left is the cue on the stand: its
number, its label, your note, and the exact instruction each named part will
receive — plus a line naming the parts that will get nothing.

Two presses, and the pointer advances by itself after the downbeat, so
conducting a run is <kbd>space</kbd> <kbd>space</kbd> … <kbd>space</kbd>:

| | |
| --- | --- |
| **PREP** / <kbd>space</kbd> | the named players' lights go amber and they read the incoming instruction under their current one |
| **DOWNBEAT** / <kbd>space</kbd> | the lights flash white and the instruction swaps |
| <kbd>esc</kbd> | never mind — the lights go out and nothing changed |
| <kbd>→</kbd> <kbd>←</kbd> | move the pointer (this also drops an unfired prep) |

Tick **count-in** and PREP starts a visible count instead: the players' lamps
show `4 3 2 1` at the tempo you set, and the downbeat lands at the end of the
count by itself. Pressing DOWNBEAT during the count fires early; <kbd>esc</kbd>
stops it.

On the player's side the cue light sits to the **left** of the instruction,
first thing on the line, where it is caught out of the corner of an eye while
looking at the strip. The part name is not repeated beside it — it is already in
the header.

The roster along the top is who is actually connected. Every player announces
itself every few seconds with its part, the cue it is on, and an id of its own,
so each part shows **how many machines are on it** — two players to a part being
the normal case here — and the total is under the row. A part reading `0 ·
nobody` is a laptop that never woke up; a part showing two different cue numbers
is one player adrift, and you can see it before it becomes audible.

A player who reloads or joins late is handled without you doing anything: the
conductor repeats the standing cue quietly every couple of seconds, and a player
who was not there for the downbeat picks up the instruction with no flash. They
missed the downbeat; they should not be handed a fake one.

### On a network

The bridge listens on every interface, so the other laptops need only the
conductor's address: it prints the URLs to hand out when it starts.

```
[scan-bridge] players  http://localhost:8080/
[scan-bridge] conduct  http://localhost:8080/conduct.html
[scan-bridge] on the network: http://192.168.1.42:8080   (en0)  + /conduct.html to conduct
```

**The bare address is the player's page** — a player types `192.168.1.42:8080`
and nothing else; only the conductor adds `/conduct.html`. (Both are redirects to
`/scan/` and `/scan/conduct.html`, so the old paths keep working and a query
string survives: `192.168.1.42:8080?part=2` skips the part modal on a machine
that is always the same part.) The page finds the WebSocket on the host it was
served from, so nothing needs configuring per laptop. Everyone must be on the same
network, and a Mac will ask to allow incoming connections the first time.
`--host 127.0.0.1` keeps the bridge to the conductor's own machine. Writing
`presets.json`, `parts.json` and `cues.json` stays restricted to the machine
running the bridge whatever the players do, so a player cannot alter the piece.

The cue messages are ordinary bridge traffic, so they also appear on UDP **7401**
and can be sent from Max on **7400** if you ever want the cueing driven from a
patch instead — `[udpsend]` to `/cue/prep`, `/cue/go`:

| message | meaning |
| --- | --- |
| `/cue/prep <cue> <part> <instruction>` | arm that part: amber light, instruction shown as *next* |
| `/cue/count <beat> <part>` | a count-in beat, shown in the lamp |
| `/cue/go <cue> <part> <instruction>` | downbeat: flash, and the instruction becomes current |
| `/cue/clear <part>` | cancel an unfired prep |
| `/cue/state <cue> <part> <instruction>` | the standing cue, applied silently — for latecomers |
| `/player/hello <part> <name> <cue> <machine>` | sent by each player every few seconds; what the roster is built from |

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

The patch report goes to the browser console rather than to the page — players
should see a piece, not a build status. On a good load you get one line,
`Tract: all 6 worklet patches applied (…)`; if upstream ever changes and a patch
fails to match, it is a `console.warn` naming the ones that missed, rather than
silently sounding wrong.

---

## Control from Max

(The piece needs no Max. The panel that used to describe this on the player's
page is gone — it was one more thing between a player and the score — but the
bridge still speaks OSC exactly as below, so a patch can drive or listen to any
of it.)

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

## Output, and watching it

The fader is at the top of the page, under *record*, with a meter beside it —
where a player can find it in a hurry without opening a panel. The meter taps the
very end of the chain, after the fader and after the limiter, so it shows what is
actually leaving that laptop rather than what the synth would like to be sending:
solid bar for the body of the sound, pale bar for the peaks, and a line marking
the loudest moment of the last second, which turns red within 3 dB of the
ceiling. Useful for spotting the one laptop in the room that is twice as loud as
the rest, and for seeing that a part is *doing* something when you cannot pick it
out by ear.

It is the same number as the old `output` slider, which has left *timing & voice*
to avoid two faders for one thing; presets still store it.

## The skin

Two, switched with the button in the header and remembered per browser:
**pink**, which follows Pink Trombone's own palette — the pale `#FFEEF5` it fills
the tract with, orchid for anything live, black Arial — and **dark**, the
original. `?theme=pink` or `?theme=dark` forces one, which is what you want on a
machine you are about to project.

Every colour on both pages is a custom property defined in one block at the top
of `scan/index.html` (the conductor's page carries the same block), so a third
skin is a dozen lines and nothing below that block names a colour directly.

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

Open the page with **`?composer=1`** and a row appears at the top of *timing &
voice* — that flag is what turns the whole thing on, and it sticks in that
browser until you open `?composer=0`. Without it you are in player mode and the
row is not there at all; the boot line in the console says which mode you are in.
The row holds: a badge saying whether this phrase is **saved** or on the **defaults**,
then save to this phrase, revert, clear, whether **W E R** take the next word or
a random one, and the two write buttons. The dots at the top gain a green ring on
every phrase that carries a preset, so the shape of what you have tuned is
visible at a glance.

A preset holds every timing constant plus tract length, output, vibrato,
pronunciation choices and whisper. **Pitch is not in it** — that belongs to the
part's note list for the phrase and to the player's choice on the keyboard, and a
preset dragging the pitch around with it would only fight them.

Every phrase lands somewhere definite when you arrive at it: its own preset if it
has one, the shipped defaults (`DEFAULTS` + `VOICE`) if it does not. That is what
makes saving audible — before, an unsaved phrase simply kept whatever the
previous one was doing, so saving and moving away and back changed nothing and
the buttons looked dead. (Whisper is the one exception: **Z** is a live control,
so a phrase with no preset leaves it where you put it.)

**Saving writes the file.** `save to this phrase` puts the preset straight into
`scan/presets.json` in the repo, `clear` takes it back out, and editing an
instruction line writes `scan/parts.json` when you click away from it — no trip
through `~/Downloads`, nothing to move by hand, and `git diff` shows exactly what
you changed. The bridge serving the page accepts a `PUT` for those two paths and
no others. **write presets.json** and **write parts.json** are still there to
write the whole file on demand, and those two fall back to a download when
nothing can write.

The badge says which way it is going: `phrase 3: saved · presets.json` when the
file is being written, `· this browser only` when it is not. The browser copy is
a cache for that second case, so with a writing bridge **the file always wins on
load** and hand-editing `scan/presets.json` works as you would expect. Without
one — an older bridge, a `file://` path, another machine — saving stays in local
storage and the page says so rather than claiming a write.

That distinction is load-bearing: the previous bridge had no `PUT` handler at
all, so it answered a write by *serving the file back* — 200, valid JSON, and
indistinguishable from success. The page now only believes the acknowledgement
the write handler actually sends, and tells you to restart the bridge otherwise.
The writer keeps whatever else the file carried, including the `_comment` at the
top of `parts.json`, and keeps short arrays on one line so a hand-edited pitch
list stays readable.

The *timing & voice* sliders themselves stay visible for everyone; only the
preset row is hidden. Every one of them has a plain-language tooltip — hover the
label and you get a sentence with no phonetics in it ("the puff of breath between
a p, t or k and the vowel after it"), so a player can be told to nudge something
without a lesson in voice-onset time. The text is the `HELP` map in `scan.js`,
next to the control list.

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
scan/index.html                     the player's page
scan/conduct.html                   the conductor's page
scan/cues.json                      the cues, and which part each one speaks to
scan/src/conduct.js                 cue list, prep/downbeat, roster (no audio)
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
