# Tract — the piece as eight MIDI tracks

For working out how long things should last. The score deliberately does not
say; this is a way to hear a guess, change it, and hear it again.

Each player is a MIDI track. Each key press is a note, and a note's **length**
is how long the key is held. Eight browser windows, each listening to one
channel, are eight players.

```
node midi/make-midi.js        # write the .mid files from timing.json
node test/play-midi.js        # play them into real pages and say what happened (~6 min)
```

**A part keeps doing what it was last told** until a cue speaks to it again.
Parts enter one after another and pile up; a cue that speaks only to Part III
leaves I, II and IV exactly as they were.

---

## Setting it up, once

**1. A virtual MIDI cable.** On a Mac: Audio MIDI Setup → Window → Show MIDI
Studio → double-click **IAC Driver** → tick *Device is online*. One bus is
enough; all eight channels ride on it.

**2. The bridge**, as usual:

```
node scan/scan-bridge.js
```

Web MIDI needs a secure context, same as the synth does, so use the `https://`
address the bridge prints — not `http://`.

**3. Eight windows.** The quick way: double-click `midi/open-testers.command`
in the Finder, or run

```
node midi/testers.js
```

It starts the bridge if it isn't running, and opens all eight windows tiled
four by two in a Chrome of their own — its own profile, so it can skip the
certificate warning, the MIDI permission and the click-to-start-audio that
your everyday browser rightly asks for. It prints one line per window saying
whether its audio and its MIDI came up. Run it again and it replaces the eight
rather than adding eight more. If it started the bridge, the bridge stops when
you close that terminal.

By hand, the generator prints the addresses at the end of every run:

```
ch  1  /scan/?part=I&seat=1&midich=1
ch  2  /scan/?part=I&seat=2&midich=2
ch  3  /scan/?part=II&seat=1&midich=3
ch  4  /scan/?part=II&seat=2&midich=4
ch  5  /scan/?part=III&seat=1&midich=5
ch  6  /scan/?part=III&seat=2&midich=6
ch  7  /scan/?part=IV&seat=1&midich=7
ch  8  /scan/?part=IV&seat=2&midich=8
```

`?midich=N` both turns MIDI on and sets the channel. A bare `?midi` turns it on
and lets you pick the channel in the same panel where you choose the part and
type a name; that choice is remembered on that laptop, so the window comes back
on the same channel. A pill in the header says which channel it is, so eight
identical windows are tellable apart. Click each one once, anywhere, to start
its audio — until you do, the pill says *click to start audio*, and notes are
taken but nothing moves or sounds.

The windows can overlap. A window behind another still scans and still
finishes its words: the sound is clocked by a worker, not by the screen
redrawing, which Chrome all but stops for anything not in front. Clicking into
the DAW, or between windows, does not release what a window is holding.

**MIDI is a development mode.** Without `?midi` or `?midich`, a window has no
pill, no picker, and never asks the browser for MIDI access — so a performer
opening the address you give them sees nothing about any of this, and gets no
permission prompt.

**4. The DAW.** Import `out/tract-all.mid`. Eight tracks, each already on its
own channel, plus a conductor track whose markers name every cue. Send them all
to the IAC bus and press play.

In a `?midi` window with the channel left on *all channels*, every channel is
answered — which is what you want with one laptop and a keyboard plugged in by
hand.

---

## Changing the timing

Two places, for two different jobs.

**`timing.json` — the structure.** One `seconds` per cue: how long until the
next one. This is the number you are looking for. Change it, run
`node midi/make-midi.js`, and the whole piece re-lays itself around it. The
run prints where the time went:

```
  phrase   length   running
     1      0:53    0:53
     2      0:41    1:34
```

**The DAW — the nudging.** Drag the notes. Finer than the JSON, and *it does
not survive a regeneration*. So make the big decisions in `timing.json` and
save the DAW for the last ten per cent.

The ninth track is the wall. Each cue in `cues.json` that carries a `stage`
block gets one note on channel 9 — note 24 plus that cue's place in the list —
held until the next one, and `scan/stage.html?midich=9` plays it: the title
card, the tracts fading up, the words along the bottom. `node midi/testers.js`
opens that window along with the eight players, in a row of its own across the
bottom of the screen (`--no-stage` leaves it out).

Without it a simulation looks dead. The drawings are built and updating from
the moment a player feeds the stage, but `#wall` sits at opacity 0 behind the
title card until a cue says `"tracts": true`, and the only thing that ever
said it was the conductor's page. The notes are held rather than tapped so a
host that chases notes retriggers the one you land inside: scrub the transport
and the wall is in the state that moment of the piece is actually in.

Transport **start** — play from the top — puts the title card back, so a run
begins where an audience would come in. **Stop** and **continue** leave the
wall exactly as it is: stopping to talk to the room should not take the
projection down. And the page remembers where the wall had got to, so
refreshing it mid-run picks up rather than starting over — a cue's block is a
change, not a picture, and without that a reloaded page would have nothing to
show until the next stage cue came round.

Also in `timing.json`:

- `spread` — seconds of scatter between the two players on a part, so they are
  not in robotic unison. `0` lines them up exactly. A block marked
  `"together": true` ignores it.
- `sweepJitter` — seconds, for the moments where more than one part makes the
  same one-shot sweep at once: cues 6, 13, 17, 18, 28 and 38. Each of the eight
  players gets a lead of its own, drawn from its own seed, so the entry has a
  soft edge instead of eight identical ticks, and a speed of its own within
  ±4%, so the release is as ragged as the attack. At `0.08` the players land
  within about ±80 ms of each other. `0` turns the whole thing off, speed
  variation included, and the files come out exactly as they did before it
  existed.

  The lead runs from 0 to twice the number rather than either side of zero, so
  they are spread by the full amount around each other while none of them
  starts before its own cue — the previous gesture only lets go 30 ms ahead of
  the block, and an early sweep would overlap the thing it replaces.

  `loop` and `wander` sweeps are left alone. Cue 24 says "on your own, at your
  own speed", and those modes already draw their own lengths; scattering them
  further would be scattering something that is not in unison to begin with.
- `tempo` — leave it at 60 unless you have a reason. At 60 bpm one beat is one
  second and one 4/4 bar is four, so the DAW's grid and the numbers in this
  file are the same ruler.

If a cue's wording changes in `cues.json`, the run says so — `! cue 14, part 2:
the instruction has changed since timing.json read it` — rather than quietly
playing the old reading.

### A part's block

`timing.json` is one reading of the score, written by hand. Every block keeps
the instruction it reads under `from`. A block has **lanes**, and a lane it
does not mention carries on from before:

| | |
|---|---|
| `go` | go to a phrase (0 is standby) |
| `sound` | what is playing — replaces the last one. `null` is silence, `"stop"` is esc |
| `whisper` | `true` / `false`, or `{"bursts": [gap], "len": [len]}` for voiced notes breaking out of a whisper, or `{"voiced": 9}` for more and more voiced over 9 s, or `"steady"` to end the bursts |
| `pitch` | `{"set": 69}`, `{"slide": [62, 69], "every": [0.8, 2]}`, `{"widen": [[62, 69], [60, 76]]}`, `{"drift": [69, 55]}` (a semitone at a time, across the span), `{"alternate": [31, 32]}` (after every word), or `"stay"` |
| `j` | `[5, 10]` presses J every 5–10 s; `"stop"` |
| `pedal`, `pedalAt` | `"down"` / `"up"`, so many seconds into the cue |
| `fade` | the diminuendo, so many seconds in |

Sounds:

```jsonc
{ "scan": "A" }                                 // held, pressed again at the end of each pass
{ "scan": "A", "once": true }                   // held until the next instruction
{ "words": "R", "every": [0.35, 0.9] }          // a press every 0.35–0.9 s
{ "words": "W", "gap": [0.3, 0.45] }            // each word, then a gap: a pulse
{ "words": "E", "gap": [0.2, 0.6], "jAfter": true }  // and J after each one
{ "shots": "T", "every": [0.12, 0.4], "hold": [0.06, 0.12] }
{ "sweep": [0.5, 0.944], "secs": 3, "mode": "once", "then": "hold" }
{ "sweep": [0.6, 1], "secs": [5, 6.5], "mode": "loop" }   // again and again
{ "sweep": [0.47, 0.53], "secs": [1.2, 2], "mode": "pingpong" }
{ "sweep": [0, 1], "secs": [1.5, 5], "mode": "wander" }   // anywhere, freely
{ "hold": 0.967 }                               // the mouse held at one place
[ { "words": "R", "once": true }, { "at": 1.8, "words": "R", "every": [0.35, 0.9] } ]
```

Positions are 0–1 along the strip, by cell, from `phrase-cells.json` — 0.944 on
phrase 1 is the last [n] of 'strain'. A list is a sequence, each with its `at`.
Any range is random inside it, seeded from the cue and the player, so the same
file always renders the same irregularity and two takes can be compared.

A held scan is held for the pass's expected length **plus 2.2 standard
deviations** and then pressed again. The page draws each cell's length at
random, so the press cannot know where the end is; let go early and the next
press only finishes the old pass and then waits out a whole hold. Waiting a
moment at the end is what the score describes anyway. A new scan starts from
the top of the strip unless it says `"continue": true` — "finish the scan you
are on".

---

## What the notes mean

The bottom two octaves are the player's keyboard. From C1 up, notes set the
pitch, exactly as they did before — a keyboard plugged in by hand still works.

| note | | key | |
|---|---|---|---|
| 0 | C-1 | `A` | scan, slow — **held** |
| 1 | | `S` | scan, middle — **held** |
| 2 | | `D` | scan, fast — **held** |
| 3 | | `W` | one word, slow |
| 4 | | `E` | one word, middle |
| 5 | | `R` | one word, fast |
| 6 | | `Q` | a voiced phoneme — **held** |
| 7 | | `T` | a noisy one — **held** |
| 8 | | `Z` | whisper on / off (a toggle — the files use 14) |
| 9 | | `space` | the damper pedal — **held** |
| 10 | | | the diminuendo |
| 11 | | `esc` | stop everything |
| 12 | B-1 | `J` | change pitch |
| 13 | | | the mouse on the strip — **held**, with CC1 |
| 14 | | | whisper — **held**: whispering for as long as it lasts |
| 15 | | | standby |
| 16–23 | C0–B0 | | phrases 1–8 — **held**, see below |
| 24+ | C1 | | set the pitch, and open the gate as a keyboard does |
| CC 1 | | | the mouse's position on the strip |
| CC 20 | | | which phrase — 0 standby, 1–8 |
| CC 21 | | | the pitch as a note number — the gate is left alone |
| CC 120 / 123 | | | all sound off / all notes off — lets go of everything held |
| Stop (0xFC) | | | the same, from a host that sends transport to the bus |

**Sweeps** are note 13 plus CC1: hold the note for the mouse button and draw
CC1 for where the mouse is. Letting the note go closes the gate, so a sweep
cannot be left hanging open — unless the pedal is down, which is "sweep to the
[n] and hold with {space}". Pressing the note cancels a running key, as taking
hold of the strip does.

**Whisper is a lane, not a toggle.** Z flips whatever the window is doing, so
a run of Zs is only right if every window started the right way round and
nobody located the playhead — neither of which a DAW promises. Note 14 held is
whispering; let go, voiced.

**The phrase lane, and skipping around.** Phrases are not a blip at each
change — each one is a single long note held for as long as that phrase lasts,
so in the piano roll it is a bar you can see and drag. Landing the playhead
inside one gets you onto that phrase two ways: a host that chases notes
retriggers the bar you dropped into, and CC20 carries the same number for hosts
that chase only controllers. Nearly every host does one or the other.

Both are **idempotent** — arriving at a phrase you are already on does nothing
at all. That matters: without it, locating during a phrase would stop a running
scan and re-apply its preset underneath the player, and landing on standby
would rebuild the synth every time.

Pitches are dealt out by the page, by seat, from `parts.json` — which is why
the two players on a part are on different seats. Where a cue names one
("Choose <A4>", "slide between <D4> and <A4>"), the files send it on CC21,
which sets the note without opening the gate. A note from C1 up would open
it, and its note off would punch a hole in whatever was scanning.

---

## Keeping it in step with the piece

Two inputs decide how long a held scan takes, and the generator gets both
rather than keeping its own copy:

- **the rates** come out of `scan/src/scan.js` — it reads the `RATES` and
  `SHOT_RATES` tables and prints what it found on every run. Retune `slow` by
  ear and the sequenced run follows you.
- **`phrase-cells.json`** is each phrase's strip as a real page lays it out:
  every cell's phoneme, word and width. Pass lengths, word lengths and sweep
  positions all come from it. Change the words of a phrase and that file is
  stale: the timings drift and the sweeps land on the wrong letters.
