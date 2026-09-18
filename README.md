# Tract

Jason Charney (2026).

A phoneme strip you scan by hand or by key: hold the mouse down and drag across
it, or hold a key and let it advance itself, and it speaks — holding each
phoneme as long as you stay on it, while stops keep the ballistic burst timing
that makes them intelligible at any speed. Built for a four-part laptop-ensemble
choir painting text from Eliot's *Four Quartets*.

```
node scan-bridge/scan-bridge.js
open http://localhost:8080/scan/     # Chrome, then "enable audio"
```

**[scan/README.md](scan/README.md) is the real documentation** — the scanning
model, the keyboard scheme, the composer presets, why the upstream plosive burst
was broken and what this does about it, and the OSC interface if you ever want
Max in the loop again.

## Playing

Left hand, no trackpad needed:

| key | |
| --- | --- |
| **A S D** | hold to scan — slow (4–6 s per phoneme), mid (1–3 s), speaking (0.5–1 s) |
| **W E R** | one word at slow / mid / speaking tempo |
| **Q** | a random phoneme from the phrase |
| **T** | a random stop or fricative, unvoiced — percussion |
| **1**–**8**, **↑ ↓** | choose the phrase |

Letting a held key go closes the gate where you are; pressing again carries on
from there.

## Layout

```
scan/                       the interface
  index.html                the page
  src/engine.js             articulation engine — no DOM, no Web Audio beyond AudioParams
  src/patched-pink-trombone.js   in-memory repair of the worklet's burst and pitch drift
  src/scan.js               audio setup, strip UI, keyboard transport
  presets.json              per-phrase settings that ship with the piece
scan-bridge/
  scan-bridge.js            static server + WebSocket + OSC/UDP, no dependencies
  scan-control.maxpat       Max control patch — optional, the piece needs no Max
src/                        upstream: phoneme table, IPA dictionary
pink-trombone/src/          upstream: the synth itself
```

## Provenance

`src/` and `pink-trombone/src/` are files from
[zakaton/pink-trombone-demos](https://github.com/zakaton/pink-trombone-demos),
unmodified, carried over because the page depends on them at the absolute paths
they expect. Only the four files that implementation actually needs were brought
across.

`scan/` and `scan-bridge/` are new.

The worklet is never modified on disk — `patched-pink-trombone.js` fetches it,
patches it in memory and imports it as a blob module, so upstream stays pristine
and `?nopatch=1` gives you an A/B.
