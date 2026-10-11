# Tract — a scannable Pink Trombone

Jason Charney (2026). A phoneme strip you scan by hand or by key, built on
`zakaton/pink-trombone-demos`, for a four-part laptop-ensemble choir painting
text from Eliot's *Four Quartets*.

```
node scan/scan-bridge.js
open http://localhost:8080                   # a player
open http://localhost:8080/conduct.html      # the conductor
open http://localhost:8080/stage.html        # the projection
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

**The page opens on phrase 0**, which is standby: the piece has not started. It
is a real phrase as far as everything else is concerned — you can be sent to it,
step off it with **]**, and come back with **[** or **0** — but it has no words.
The strip holds a single rest, a schwa with the voice off, so the tract is a real
tract and there is nothing to sound: leaning on **A S D** there does nothing at
all. A player who opens the page early is not left sitting on
"words strain" with a live strip under their hands. Phrases 1–8 keep their own
numbers, so `cues.json`, `presets.json` and `parts.json` are untouched by it, and
a conductor can send `/scan/phrase 0` to put the room back on standby.

**Nothing is heard as the page comes up**, and getting there took three separate
fixes, because the blurt players heard on choosing their part had three causes.

The output used to go live at full gain the moment the gain node was made, about
fifty milliseconds before the gate is closed and the intensity zeroed; it now
starts at zero and fades in over 80 ms, and the synth is not started at all until
the tract has been posed. Standby used to hand the engine *no cells*, and with no
cells `update()` returns at once, so the tract is never posed and never told to
be quiet — it sits on whatever geometry the worklet came up in. Standby now rests
on a schwa with the voice off: a real vocal tract, silent, posed every frame like
any other cell. That is also why the tract view used to fly apart on load.

The third one is upstream's. **Pink Trombone's worklet emits NaN for its first
seven render quanta**, about 19 ms, every time it starts — measured here, and
measured again with `?nopatch=1`, so it is not one of this repo's patches. NaN is
not quiet: it clicks on the way out, it draws as a tract that has exploded, and
if any of it settles into the delay line that laptop is silent for the rest of
the piece. Turning the gain down does not help, because NaN times zero is still
NaN. So a small guard worklet sits between the synth and everything downstream
and replaces any non-finite sample with silence (and clamps past ±4, which no
real signal here reaches). If it cannot be installed the synth is wired straight
through and a warning goes to the console — a guard that fails should not cost
you the piece.

Measured at the page's own output, on the machine this is played on: zero
non-finite samples through startup, digital silence until a key is pressed.

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
| **Q** | hold for a random **voiced** phoneme of the phrase |
| **T** | hold for a random **noisy** one — fricative, stop, anything unvoiced |
| **Z** | whisper on / off — latching, and it survives **T**. A pill under the strip says which it is |
| **space** | the pedal — see below |
| **J** | move to another of this phrase's written pitches |
| **↓** | the diminuendo: fade this laptop to silence over the length the conductor has set |
| **↑** | call the diminuendo off |
| **0** | standby — phrase 0, where the page opens |
| **1**–**8**, **[** **]** | choose the phrase, or step through them |
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
entirely — the chips then read "any pitch". Coming back to a phrase gives you
back the pitch you were on there, not the top of the list; a phrase you have
never been to starts on its first pitch.

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

## The spacebar is a pedal

Hold it and whatever is sounding keeps sounding: the phoneme under the playbar,
or the one **Q** or **T** just threw up. It behaves like a damper pedal rather
than a second gate key, which is what makes it useful for controlling the level
of the random keys without giving every player another slider:

**Q** and **T** are held keys, not one-shots: the phoneme they throw up lasts
exactly as long as you hold the key, and takes the release envelope when you let
go. That is the simple case, and it is what most playing is. They used to fire
for a fixed few tenths of a second, which left an audible seam between the shot
ending and the pedal catching it — very obvious on a voiced one like the ð or ʒ
of phrase 6.

The pedal then works the way a piano's does, on top of that:

- A held phoneme sounds while **either** the key or the pedal is down, so
  catching a **Q** with the pedal and then lifting the key is seamless — there
  is nothing to catch, because the note was never going to stop on its own.
- Letting the **pedal** go while **Q** is still held keeps the note; letting
  **Q** go while the pedal is held keeps it too. It ends when neither is down.
- Letting a scan key (**A S D**) go under a held pedal leaves the phoneme
  sounding where it stopped.
- The bar never moves the playbar; it sustains where you already are.

**Release** in *timing & voice* is how long a pedalled phoneme takes to die away
— 10 ms to 3 s, a diminuendo instead of a cut. It applies only to the pedal;
stops keep their own ballistic timing, which is not a thing you would want
smeared. Measured: at 1.5 s the sound carries about a second past the bar coming
up; at 0.05 s it stops with it.

## Ending the piece

Everyone fades together, on one key. **↓** starts a diminuendo on that laptop and
runs it down to silence; **↑** calls it off, for the rehearsal where somebody
finds the key in the middle of phrase three. The arrows no longer change phrase —
that is **[** and **]** and the number keys — precisely so this one cannot be hit
on the way to somewhere else.

How long it takes is the conductor's, not the player's: a box on the desk, in
seconds, 5 until it says otherwise. It goes out with every heartbeat as well as
on change, so a laptop that joins late is not the one still sounding five seconds
after everyone else. The player's page shows the current length in the key
legend, and counts the fade down while it runs.

It rides a gain stage of its own, downstream of the player's fader, so riding
your own output during the fade still works and the fader is where you left it
afterwards. The curve is shaped rather than linear — a straight amplitude ramp is
heard as full volume followed by a cliff.

## The clocks on the desk

Three, because three different questions get asked in a performance:

- **piece** — how far in we are. It starts at **cue 2**, not when the page was
  opened and not at cue 1, which is the one you give while the room settles.
  `START_CUE` in `conduct.js` is the one place that says so.
- **phrase** — a lap, restarted whenever a fired cue belongs to a different
  phrase than the last one did. It names the phrase it is timing.
- **since cue** — how long since the last downbeat, which is the one that tells
  you a section has run long.

All three read `m:ss.s` and there is a **reset** beside them for before a run.

## How a pitch gets chosen

Some phrases need a pitch in a particular player's mouth; some only need a pitch
from a set; one or two want the pitch to be moving. A phrase says which by adding
`"pitch"` to its entry. **Leaving it out means free choice**, which is what every
phrase in `parts.json` does today — so nothing in the piece changes until you
write one in.

```json
{ "notes": ["G3"],             "pitch": "fixed"  }
{ "notes": ["G3", "D3"],       "pitch": "assign" }
{ "notes": ["G3", "D3", "A3"]                    }   ← "choose", by saying nothing
{ "notes": ["E2", "B2"],       "pitch": "drift"  }   ← the edges of a band
```

**fixed** — the one written pitch, and it is put back if a player wanders off it.
Use it where a line has to be in tune with another part.

**assign** — the part's pitches are shared out among the players *on that part*,
which is what makes "both pitches are heard" true rather than likely. Each page
works out its own seat — **II-1, II-2, II-3** — by sorting the machine ids it has
heard say hello on its part and taking its own index, so every page reaches the
same answer with no conductor in the loop and nothing to set up. Seat *n* takes
`notes[(n − 1) % notes.length]`: two pitches over three players gives 1, 2, 1,
three pitches over four gives 1, 2, 3, 1. Nobody is ever left doubling while a
written pitch goes unsung. Seats are re-taken at a phrase change, and otherwise at the
first quiet moment after the roster changes — no key held, no scan running, the
gate closed — so a pitch is never pulled out from under a player who is singing,
but two players who open the page together and never change phrase still settle
onto different pitches instead of both taking the first one. `?seat=2` pins a
seat for a rehearsal.

**choose** — the player picks, but not from nothing: the *starting* pitch is
handed out by seat exactly as `assign` does it, so a part that opens on a chord
opens on the whole chord rather than four players all on the first written note.
Nothing keeps them there — the chips, the keyboard and **J** all still work, and
**J** moves to a different written pitch (with two written, it alternates; with
more, it draws from the others, so two players leaning on J do not march in
step). The choice belongs to the phrase, so stepping away and back returns you to
it.

**drift** — `notes` are the **edges of a band**, not a list. The lowest and the
highest light up on the piano along with every key between them, and the player
clicks anywhere inside to move the pitch. The written notes still appear as
chips, because they are the landmarks worth aiming at, but nothing stops a player
landing between them.

Nothing moves the pitch except the player. The page does not redraw it, and **J
does nothing in a drifting phrase** — a band is not a set, so there is no "a
different one of them" to jump to. What you hear as a *slide* rather than a jump
is the **pitch glide** in timing & voice, which runs to **2 s**: at the default
0.05 s a click is a step, and at a second or more the voice is still travelling
when the hand moves again, which is "slip, slide, perish". Turn **wobble** down
to 0 first, or the drift and the wobble fight each other.

Like a chosen pitch, a drifting one belongs to its phrase: step away and back and
you are where you left off. Players enter spread across the band by seat, the
same way `choose` hands out its opening pitches.

The player's page says which of the four is in force — *pitch: written / yours by
seat / your choice / drifting* — with the seat beside it when more than one player
is on the part, and the assigned chip ringed. A drifting phrase names its band
— *pitch: anywhere E2–B2* — and lights every key in it.

The conductor's desk checks the arithmetic for the cue it is standing on and says
so when it does not work out: **II: 1 player for 2 pitches — D3 unheard**. It
clears itself the moment somebody joins. Only `assign` phrases are checked;
free-choice parts are nobody's business but the players'.

A pitch named in an instruction is written `<A4>` in `cues.json` and comes out as
a rounded chip, in a different colour from the `{KEY}` boxes: one is a thing you
press, the other a thing you sing. Fractional and accidental spellings work the
same way — `<B♭2>`, `<51.5>`.

Each phrase entry in `parts.json` also carries a `_comment` naming the line it
belongs to — `"5 — slip, slide, perish"` — put first in the entry so an editor
shows you which phrase you are in without counting braces. The app ignores it on
the way in and rewrites it on every save, from `PHRASES` in `scan.js`, so
renaming a phrase there cannot leave a stale label behind.

Pitch lives in `parts.json` and never in a preset — a preset is the *sound* of a
phrase, the same for everyone singing it. Glide, vibrato depth and wobble are
preset properties, so the same drifting phrase can slide in one performance and
step in another without touching the parts file. **Pitch drift (wobble)** now sits
under the phoneme strip rather than in that panel, within reach during rehearsal;
it is still saved with the preset.

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

Beside the count is **the phrase that part is on**. Players advance themselves,
so this is the only way to know: *standby* before the piece starts, *phrase 3*
once they are in it, and **`phrase 3 / 4` in amber when the players on one part
do not agree with each other** — someone who has not moved yet, or has moved
early. It rides on the hello rather than on `/tract/phrase`, which is only sent
when a projection is listening, so the desk has it whether or not anyone is
running the stage.

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
[scan-bridge] stage    http://localhost:8080/stage.html
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
| `/player/hello <part> <name> <cue> <machine> <phrase>` | sent by each player every few seconds; what the roster is built from. `<phrase>` is 0 for standby, 1–8 otherwise |
| `/stage/hello` | the projection page, saying it is listening |
| `/tract/frame <part> <machine> <json>` | one player's tract geometry; relayed between pages only, never sent to Max |
| `/tract/phrase <part> <machine> <n> <text>` | which phrase that player is reading; what the stage's subtitles are built from |

## The projection

`scan/stage.html` — open it on the machine driving the projector, click once for
full screen. It opens on the **title card** by itself, before any cue and before
the bridge has said anything, so the projector can be set up hours early and left
there. Everything after that is the conductor's.

### The stage is a cue target

A cue in `cues.json` may carry a `"stage"` block beside its `"parts"` block:

```json
{
  "id": "2",
  "phrase": 1,
  "label": "Start of Phrase 1",
  "stage": { "title": false, "tracts": true, "text": "words strain", "fade": 3 },
  "parts": { "1": { "instruction": "…" } }
}
```

It is a sibling of `"parts"` rather than a part of its own, because the stage is
not a player: no pitches, no seat, no instruction to read. Every key is optional
— a block that says only `"text"` changes only the words.

| key | |
| --- | --- |
| `title` | `{ "main", "sub", "by" }` to show the card, a plain string for the big line alone, `true` for "show it exactly as it is", `false` to fade it away |
| `tracts` | `true` fades the wall of tracts in, `false` fades it out |
| `text` | the subtitle; `""` clears it |
| `fade` | seconds, for everything in this block. Default 2 |

The two halves of the opening are deliberately **two cues, not one**. Cue 1 takes
the title card to the background and leaves the screen empty; cue 2 — the start
of phrase 1 — brings the tracts and the first words up. The empty screen in
between is not dead time: it is the audience being told to settle, and it means
neither fade has to wait for the other.

(If you ever do want one cue to do both, it still works: the wall waits for the
card to be gone rather than crossing it.)

A **title card** button on the desk puts the card back up without a cue — before
a run, or between takes in a rehearsal. It sends `"title": true`, so it does not
need to know what the card says.

Nothing on the stage watches the players any more. It used to take a majority
vote of everyone's current phrase, so the words changed when enough laptops
happened to agree rather than when you said so; that logic is gone. The
conductor's desk marks every cue that speaks to the stage with a **▣** chip, and
spells out what the standing one does — *stage — title card away, tracts in,
subtitle "words strain", over 3s*.

The desk repeats the **accumulated** stage state on its heartbeat, not the last
block, so a projector plugged in halfway through arrives at the state the piece
is in — no fade, no title card over the middle of the third phrase. Applying a
state the stage is already in does nothing, which is what makes that safe.

The cue sheet as it stands: the card is up from the moment the page loads, cue 1
fades it to background over 3 s, cue 2 (the start of phrase 1) brings the tracts
and the words up over 3 s, the first cue of each phrase sets that phrase's words,
and cue 39 — the diminuendo — takes the wall and the words back to the background
over 8 s.

### The wall itself

Every player's vocal tract, side by side, filling a 16:9 screen.

It makes no sound and runs no synth. Each player streams **the real thing** — the
44 tract diameters its own visualiser is drawing from, twenty times a second —
and the stage draws them with upstream Pink Trombone's own geometry: same
origin, radius, scale and angle sweep as `TractUI`. What the room sees is the
shape the player is playing, not an impression of it.

| | |
| --- | --- |
| tiles | one per connected player, ordered by part; a player who goes quiet for six seconds drops out and the grid closes up |
| the grid | every column count is tried and the one that wastes the least wall wins — 2×2 for four, 3×2 for five with the short row centred |
| colour | voiced tracts in Pink Trombone's pink; a whispering one loses its outline colour and dims |
| the bead | sits where the tract is widest and brightens with how loud that player is, in a colour chosen against the tract rather than with it |
| the shimmer | upstream's own wobble, driven by the amplitude at the lips |
| the title card | its words are in `stage.html` (`id="titleCard"`) or come from a cue; its look is four CSS rules — `.titlecard`, `.titlecard-main`, `.titlecard-sub`, `.titlecard-by` — and nothing else on the page touches them. Sizes are in `vw`, so they scale with the projector |

Every page instance gives itself an id when it loads, and that is what the stage
counts. It used to come from `sessionStorage` — which a browser *copies into a
duplicated tab*, so opening players that way made three of them claim to be one
machine: one big tile flickering between three tracts, and a conductor's roster
that counted one. A reload now simply looks like a new machine, and the old one
ages out of both in a few seconds.

Nothing is sent unless a stage is listening. The stage says `/stage/hello` every
two seconds; a player streams only while it has heard one in the last six, so
rehearsing without a projector puts nothing extra on the wire. The frames are
relayed between pages only — they never reach the Max UDP port, which would
otherwise get forty-four numbers per player per frame.

One wrinkle worth knowing: upstream keeps its main-thread copy of the tract up
to date only while its visualiser is animating. So while a stage is watching, a
player whose tract panel is folded away starts that loop anyway, invisibly, and
gives it back when the stage goes quiet. A player with the panel closed still
appears on the wall.

**Subtitles.** The words of the phrase sit along the bottom, and the wall gives
up a strip for them rather than drawing a tract underneath. Players can be on
different phrases — that is what half the cues are for — so the line shows the
phrase *most* of them are reading, fading out and back when the majority moves.
The text is sent on its own, when a player changes phrase and on a slow
heartbeat, rather than riding along with the tract frames twenty times a second.
Nobody playing means no line at all, and `?subtitles=0` turns them off for a run
where the words would give the game away.

Dark is the default here too — a lit pink wall behind an ensemble is a lot of
room to light up — and `?theme=pink` gives the Pink Trombone palette if that is
what the piece wants. The bead reads mint against the pink tract in the dark and
deep plum in the light skin, so loudness is visible from the back of the hall.
The cursor hides itself after a few seconds, and `?debug=1` puts a small list of
who is feeding the wall in the corner while you set the room up.

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

## Control over OSC

(The piece needs none of this. The panel that used to describe it on the player's
page is gone — it was one more thing between a player and the score — and so is
the Max patch that used to sit beside the bridge. The bridge still speaks OSC
exactly as below, so QLab, Max, or anything else that sends OSC can drive or
listen to any of it.)

Send to UDP **7400**, listen on **7401**. Anything beginning with `/` is treated
as OSC; in Max that is `[udpsend 127.0.0.1 7400]` and `[udpreceive 7401]`, and in
QLab it is a plain network cue.

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

Two, switched with the button in the header and remembered per browser. **Dark**
is the default and what the piece is performed in. **Pink** follows Pink
Trombone's own palette — the pale `#FFEEF5` it fills the tract with, orchid for
anything live, black Arial. `?theme=pink` or `?theme=dark` forces one, which is
what you want on a machine you are about to project; a browser that has already
been switched keeps its choice until you switch it back or pass `?theme=`.

Every colour on both pages is a custom property defined in one block at the top
of `scan/index.html` (the conductor's page carries the same block), so a third
skin is a dozen lines and nothing below that block names a colour directly.

## Sibilants

/s/ was heard as loud next to the voiced phonemes, and measurement agreed: on
"words strain", A-weighted, it sat about 10 dB above the average of the phrase's
voiced cells. A-weighting matters here — a sibilant's energy is exactly where the
ear is most sensitive, so plain RMS flatters it.

**sibilant level** in *timing & voice* trims the voiceless sibilants. It is not a
fader: the synthesis drives frication nonlinearly, so the curve is steep —
measured on the same phrase, 1.0 put /s/ +9.8 dB over the voiced average, 0.97
+4.3, 0.95 +1.8, **0.93 +0.2**, and 0.90 already −4.3. 0.93 is the default.

Voiced sibilants are deliberately left alone: /z/ measured *below* the voiced
average to begin with, and trimming it would have cost 7 dB of something nobody
complained about. That is also why the whispered balance is untouched.

While fixing this I found that changing any of the settings baked into a cell at
build time — the voiceness values, this one, the pressure and burst intensities —
did nothing at all until the next phrase change, because only
`holdWordFinalStops` asked for a rebuild. `REBUILD_KEYS` in `scan.js` now lists
all of them.

## The piano

The strip under the readout sets the pitch: click a key and the voice moves
there, and it follows the pitch slider and `/scan/note` the other way, so
whatever sets the pitch, the keyboard shows it. Fractional MIDI notes still
work — the piano highlights the nearest key and the label gives you the exact
value and frequency. It runs C1 to **C5**, which covers everything written in the
piece with room either side.

The **C**s are labelled, large enough to find from playing distance. **note
names** beside the keyboard puts a name on *every* key, black ones included, for
a player who does not read a keyboard by eye; it is off by default and
remembered per browser.

## Vibrato, and singing without it

`vibrato rate` and `vibrato depth` are the periodic vibrato; `wobble` is the
slow random drift. Set both depth and wobble to 0 and the pitch is genuinely
steady: measured over two seconds, 2 cents of standard deviation. That needs the
`steady-pitch` patch, because the glottis otherwise adds two unconditional
simplex drifts that no parameter turns off.

## The release, and why every ramp was jumping

Letting go of a held phoneme used to drop the voice eight to twenty decibels
instantly and then crawl the rest of the way down. Two things were wrong, and
the first was not about the release at all.

**Every ramp started from the wrong place.** `_ramp` called
`cancelAndHoldAtTime(now)` before scheduling, which is meant to pin the
parameter where it is — but it does nothing when the timeline has no event
*after* `now`, which is the normal case once an earlier ramp has finished. The
new ramp then interpolated from whatever the last event was, often a second
earlier, so the value jumped to wherever that old line crossed the present.
Measured: a note held 0.9 s and released with a 1.5 s fade put intensity at
**0.63 the instant you let go**, not 1.0. `_anchor` now writes an explicit
`setValueAtTime` at the current value first. That fixes attacks and
transitions as well as releases.

**And a straight line is not a straight fade.** The voice follows intensity
*squared* — measured against the running synth, 0.5 is 12 dB down, 0.1 is 40 dB
down, 0.01 is 80 dB down — so a linear ramp on intensity holds near full for
most of its length and then falls off a cliff. `_fadeOut` lays a chain of
straight segments along an exponential instead, which comes out as a constant
number of decibels per second and still reaches true silence. A 1.5 s release
now measures 0, −1, −2, −4, −6, −8, −12, −20, −28, −32, −41, −49, −57 dB and out —
about 40 dB per second, all the way.

The ordinary gate close uses the same fade, so releasing the mouse is smooth
too, just quicker.

## Serve it from a secure context if you can

`AudioWorklet` only exists in a **secure context** — https, or localhost. Handed
to an ensemble over plain http on a LAN address, it is simply absent, and two
things follow, neither of them announced:

* upstream quietly falls back to a **ScriptProcessorNode**, which runs the whole
  synth on the main thread;
* our **NaN guard could not install at all**, because it was AudioWorklet-only.
  That is the configuration where the opening burst goes straight through to the
  speakers and into the tract view.

The console says which you are in:

```
Tract: NaN guard installed (AudioWorklet).                  <- good
Tract: no AudioWorklet here, so the NaN guard is running    <- plain http
as a ScriptProcessorNode instead. ...
```

**The guard now has a ScriptProcessorNode fallback**, so it installs either way
and the NaN never reaches the output. But the worklet path is better on every
count — the synthesis runs off the main thread instead of competing with drawing
eight tracts — so it is worth the two minutes:

**There is nothing to do.** Start the bridge the way you always do:

```sh
node scan-bridge.js
```

On startup it looks at the addresses this machine currently has, and issues
itself a certificate if it needs one — because there is none yet, because the
one here has expired, or because **the room has changed and the addresses with
it**. A browser checks that a certificate names the exact address it dialled, so
one made at home is wrong at the venue; that is a thing to find out before a
rehearsal rather than during one. It says what it did:

```
[scan-bridge] made a certificate — this machine is now 192.168.1.42
[scan-bridge] covering DNS:localhost,IP:127.0.0.1,IP:192.168.1.42
[scan-bridge] players  https://localhost:8080/
```

and when the one on disk is still right, it just uses it. `openssl` does the
work — it is already on macOS and Linux; if it is missing the bridge says so and
carries on over plain http. `--no-tls` forces plain http, and `--cert`/`--key`
point at your own pair and are then used exactly as given, with no regenerating.
`./make-cert.sh` still does it by hand if you want to.

The pages build their own `wss://` from wherever they were served, so nothing
else changes, and the key is gitignored.

Each player types the `https://` address, sees **"Your connection is not
private"**, and clicks **Advanced → Proceed to … (unsafe)**. Once per laptop per
Chrome session. On Safari it is **Show Details → visit this website**. Do it in
the soundcheck, not at the top of the piece.

Verified end to end over https with a self-signed certificate: secure context,
AudioWorklet present, the guard on the worklet path, `wss://` carrying the
roster to the conductor's desk, and sound at the usual level.

The alternative, if certificates are more trouble than they are worth in the
room: give each laptop `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
with the bridge's `http://` address and restart Chrome. No warnings, but it is a
per-laptop setting that survives until someone clears it.

`window.__forceScriptSanitizer = true` before enabling audio exercises the
fallback on a machine that does have AudioWorklet.

## Standby rebuilds the synth

The worklet can come up wrong: a burst of noise as the page loads, the tract
view flying apart, and then a voice that will not sound again. That is NaN in
the tract's delay line, and once it is in there it stays — nothing reachable
from outside the processor clears those arrays. The cure is a new processor.

**Going to standby — {0}, or the standby dot — now builds a fresh one.** The
fader is taken to zero, the old node is stopped, disconnected and parked, a new
`<pink-trombone>` is made, posed and started, and the output fades back in.
Measured at **13–31 ms**, and silent at both ends. Four resets in a row leave
exactly one node in the tract view and one in the document, so nothing piles up.
`window.scan.resetEngine()` does the same from a console.

Standby is the right place for it: the piece is not sounding, everyone is
waiting, and a player who has lost their voice already knows to press {0}.

One wart: each retired node logs a single upstream `TypeError` on its way out —
its own `getProcessor` reply dispatches at `event.target`, which the browser has
nulled by the time the promise resolves. About one per reset, not one per frame,
and nothing downstream is affected. It is left visible rather than swallowed.

## Whisper belongs to the players

**Whisper is not a preset property.** It was, and a phrase with a preset of its
own reached across a phrase change and reset it under the player's hands — which
the cue sheet does not expect, because the cues tell players when to turn it on
and off themselves. `capturePreset` no longer stores it and `applyPreset` no
longer touches it, and the field is gone from `presets.json`.

Since nothing resets it any more, a player can carry a whisper across a phrase
change without noticing, so there is a pill under the strip — **Z WHISPER ON**
in full colour, **Z whisper off** outlined — where they are already looking.
**T** still borrows whisper for its noise and hands it straight back.

## The stressed-vowel lift

`stressed-vowel lift` in *timing & voice* is how far the pitch rises on a
stressed vowel, in semitones — the thing English speech does and singing a
written pitch does not. **It is 0 by default**, which means the piano is exact:
whatever key you press is what every phoneme sounds.

It used to be 0.75 and hidden, and it behaved worse than that number suggests.
`frequency()` adds the current phoneme's stress, but the frequency parameter is
only written when something ramps it — so whichever cell happened to be under
the playhead when the pitch was last set had its lift baked in and kept for
every phoneme after it. Pressing the same key on a stressed vowel and on an
unstressed one gave two different pitches, exactly three quarters of a semitone
apart, and whichever one you got then persisted until the next time you touched
the pitch. That is what made the piano feel as though it were landing a
semitone out at random.

The lift now follows the playhead, so turning it up gives real prosody rather
than a frozen accident, and leaving it at 0 gives a piano you can tune to.

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
pronunciation choices. **Pitch is not in it** — that belongs to the
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
scan/stage.html                     the projection, for the audience
scan/src/stage.js                   the tract wall: one canvas per player
scan/cues.json                      the cues, and which part each one speaks to
scan/src/conduct.js                 cue list, prep/downbeat, roster (no audio)
scan/src/engine.js                  the articulation engine (no DOM, no audio API)
scan/src/patched-pink-trombone.js   the in-memory worklet repair
scan/src/scan.js                    audio setup, strip UI, keyboard transport, transports
scan/presets.json                   per-phrase settings that ship with the piece
scan/scan-bridge.js                 static server + WebSocket + OSC/UDP, no dependencies
scan/parts.json                     the four parts: pitches per phrase, and how each one is chosen
score/make-score.js                 the printed materials, made from the files above
score/text/                         the hand-written prose: setup guide, player card
score/out/                          what comes out — HTML, and PDF with --pdf
```

## The printed materials

`node score/make-score.js --pdf` writes three documents into `score/out/`:

| | |
| --- | --- |
| **tract-guide** | setting up and rehearsing — for whoever is running it |
| **tract-cards** | the player card — half a sheet, two sides, the same for everybody |
| **tract-score** | the cue sheet, a page per phrase |

The guide and the card are prose, in `score/text/`; edit those freely. The card
is half a letter sheet: print it double-sided, cut across the middle, and one
sheet makes two cards. It carries nothing part-specific, because the pitches a
player may use arrive on their screen. **The cue
sheet is not written anywhere** — it is printed from `cues.json` and `parts.json`,
the same files the players are reading live, so the paper cannot drift away from
the screen. Change a cue and run it again rather than editing a document.

Without `--pdf` it writes only HTML, which any browser will print. With it, it
looks for Chrome in the usual places; `CHROME=/path/to/chrome` if it guesses
wrong. Nothing is installed either way.

The folder finds the piece rather than assuming where it is, so `score/` can sit
beside `scan/` or inside it; `TRACT_SCAN=/path` settles it by hand.

`engine.js` is deliberately free of DOM and Web Audio calls beyond AudioParam
scheduling, and is driven by an explicit clock (`voice.update(position, now)`),
so it can be reused anywhere — including a straight `[node.script]` host if you
ever want the synthesis elsewhere.

Options: `node scan/scan-bridge.js --port 8080 --udp-in 7400 --udp-out 7401
--out-host 127.0.0.1 --root <repo> --verbose`.
