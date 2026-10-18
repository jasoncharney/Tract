# Tract — the piece as eight MIDI tracks

For working out how long things should last. The score deliberately does not
say; this is a way to hear a guess, change it, and hear it again.

Each player is a MIDI track. Each key press is a note, and a note's **length**
is how long the key is held. Eight browser windows, each listening to one
channel, are eight players.

```
node midi/make-midi.js --scaffold    # read cues.json, write timing.json
node midi/make-midi.js               # write the .mid files from timing.json
```

`--scaffold` overwrites `timing.json` (it keeps a dated copy first). Once you
have started editing, run it **without** the flag.

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

**3. Eight windows.** The generator prints these at the end of every run:

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
identical windows are tellable apart. Click each one once to start its audio.

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

**`timing.json` — the structure.** One `seconds` per cue. This is the number
you are looking for. Change it, run `node midi/make-midi.js`, and the whole
piece re-lays itself around it. The run prints where the time went:

```
  phrase   length   running
     1      2:14    2:14
     2      1:00    3:14
```

**The DAW — the nudging.** Drag the notes. Finer than the JSON, and *it does
not survive a regeneration*. So make the big decisions in `timing.json` and
save the DAW for the last ten per cent.

Also in `timing.json`:

- `spread` — seconds of scatter between the two players on a part, so they are
  not in robotic unison. `0` lines them up exactly.
- `tempo` — leave it at 60 unless you have a reason. At 60 bpm one beat is one
  second and one 4/4 bar is four, so the DAW's grid and the numbers in this
  file are the same ruler.

### The events

`events` is a first draft, read out of the cue text. Each block keeps the
sentence it came from under `from`, so you can see what was guessed. Correct
anything that is wrong — it is a guess from prose, and some of it will be.

```jsonc
{ "k": "R", "at": 1 }                                  // one press, 1 s in
{ "k": "A", "at": 0, "hold": 36 }                      // held for 36 s
{ "k": "R", "from": 4, "to": "rest", "every": [0.35, 0.9] }   // irregular
{ "k": "W", "from": 1, "to": "rest", "every": 2.2 }    // a steady pulse
{ "k": "mouse", "at": 1, "hold": "rest", "sweep": [0.5, 1] }  // the second half
{ "k": "phrase3", "at": 0 }                            // go to phrase 3
```

`"rest"` means *to the end of this cue*, so a held note follows the cue's
length when you change it. `every` as a pair is a random interval inside that
range — but seeded from the cue and the player, so the same file always renders
the same irregularity. Two takes can be compared.

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
| 8 | | `Z` | whisper on / off |
| 9 | | `space` | the damper pedal — **held** |
| 10 | | | the diminuendo |
| 11 | | `esc` | stop everything |
| 12 | B-1 | `J` | change pitch |
| 13 | | | the mouse on the strip — **held**, with CC1 |
| 15 | | | standby |
| 16–23 | C0–B0 | | phrases 1–8 — **held**, see below |
| 24+ | C1 | | set the pitch |
| CC 1 | | | the mouse's position on the strip |
| CC 20 | | | which phrase — 0 standby, 1–8 |

**Sweeps** are note 13 plus CC1: hold the note for the mouse button and draw
CC1 for where the mouse is. Letting the note go closes the gate, so a sweep
cannot be left hanging open.

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

You still declare phrase changes the same way in `timing.json`
(`{"k": "phrase3", "at": 0}`); the generator turns a part's run of them into
the held lane.

Pitches are left to the page — it deals them out by seat from `parts.json`,
which is why the two players on a part are on different seats. Send a note from
C1 up on a player's channel if you want to override one.

---

## Keeping it in step with the piece

Two inputs decide how long a held scan takes, and the generator gets both
rather than keeping its own copy:

- **the rates** come out of `scan/src/scan.js` — it reads the `RATES` table and
  prints what it found on every run. Retune `slow` by ear and the sequenced run
  follows you.
- **`phrase-cells.json`** is how many phoneme cells each phrase has, measured
  off a real page. Change the words of a phrase and that file is stale: the
  guesses drift, nothing breaks.
