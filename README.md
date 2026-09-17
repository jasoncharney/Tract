# Tract

A scannable phoneme-strip interface for Pink Trombone: hover (or send OSC from
Max) across a strip of phonemes and it speaks, holding each phoneme for as long
as you stay on it, while stops keep the ballistic burst timing that makes them
intelligible at any scan speed.

```
node scan-bridge/scan-bridge.js
open http://localhost:8080/scan/     # Chrome, then "enable audio"
```

**[scan/README.md](scan/README.md) is the real documentation** — how the
scanning model works, why the upstream plosive burst was broken and what this
does about it, and the full OSC interface for driving it from Max.

## Layout

```
scan/                       the interface
  index.html                the page
  src/engine.js             articulation engine — no DOM, no Web Audio beyond AudioParams
  src/patched-pink-trombone.js   in-memory repair of the worklet's burst transient
  src/scan.js               audio setup, strip UI, transports
scan-bridge/
  scan-bridge.js            static server + WebSocket + OSC/UDP, no dependencies
  scan-control.maxpat       Max control patch
src/                        upstream: phoneme table, IPA dictionary
pink-trombone/src/          upstream: the synth itself
```

## Provenance

`src/` and `pink-trombone/src/` are files from
[zakaton/pink-trombone-demos](https://github.com/zakaton/pink-trombone-demos),
unmodified, carried over because the page depends on them at the absolute paths
they expect. Only the four files that implementation actually needs were
brought across; the other demos in that repo (`tts`, `lip-sync`, `knn`, …) are
not here. The original clone is still beside this folder if you want to diff
against `tts/`, which is the closest ancestor of this work.

`scan/` and `scan-bridge/` are new.

The worklet is never modified on disk — `patched-pink-trombone.js` fetches it,
patches it in memory and imports it as a blob module, so upstream stays pristine
and `?nopatch=1` gives you an A/B.
