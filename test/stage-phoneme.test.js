/*
  The phoneme written in the crook of each throat.

  "In the crook" is a claim about pixels, so it is tested in pixels: draw the
  shape alone, draw it again with the type, and see whether a single pixel of
  type lands on the drawing. Reasoning about the geometry said the first
  version was fine; it was clear of the shape but floating near the corner of
  the tile, and only looking at it showed that.

  Measured across the real range of tract widths. Sampling all 112 cells of
  all eight phrases put the middle of the tract at d = 1.30 at its widest,
  which is why the shrink-to-fit rule never fires in this piece — but the
  wide cases are here so it stays true if the words change.
*/

const { suite } = require("./lib/harness");

const SHAPES = {
  "a closed stop": "(i) => (i > 20 && i < 26 ? 0.02 : 0.9)",
  "a neutral schwa": "() => 1.1",
  "the piece's widest, measured": "() => 1.3",
  "a wide open vowel": "(i) => 1.4 + 2.4 * Math.sin((i / 44) * Math.PI)",
  "wider than the piece ever goes": "() => 3.9",
  "lips shut at the end": "(i) => (i > 36 ? 0.03 : 1.6)",
};

suite("stage phoneme", async (t) => {
  const stage = await t.stage();

  t.section("1 — the type never lands on the drawing");
  for (const [label, src] of Object.entries(SHAPES)) {
    const result = await stage.evaluate(
      async ([code, ipa]) => {
        const shapeFn = new Function("return " + code)();
        const d = [];
        for (let i = 0; i < 44; i++) d.push(Math.max(0.01, shapeFn(i)));
        const frame = { d, lip: 39, a: 0.3, i: 0.9, v: 1, f: 120, p: ipa };

        const c = document.createElement("canvas");
        c.width = c.height = 382; // a tile in a nine-player ring
        const ctx = c.getContext("2d");
        const info = { frame, canvas: c };

        // the anchor eases toward the shape, so let it settle before measuring
        for (let i = 0; i < 160; i++) window.stage.drawTract(ctx, c, info, 0);

        // the same settled state, without the type
        const bare = { frame: { ...frame, p: "" }, box: info.box, room: info.room };
        ctx.clearRect(0, 0, c.width, c.height);
        window.stage.drawTract(ctx, c, bare, 0);
        const without = ctx.getImageData(0, 0, c.width, c.height).data;

        ctx.clearRect(0, 0, c.width, c.height);
        window.stage.drawTract(ctx, c, info, 0);
        const with_ = ctx.getImageData(0, 0, c.width, c.height).data;

        let type = 0;
        let onShape = 0;
        let minX = 1e9;
        let minY = 1e9;
        let maxX = -1;
        let maxY = -1;
        for (let p = 0; p < with_.length; p += 4) {
          const wasDrawn = without[p + 3] > 8;
          const isDrawn = with_[p + 3] > 8;
          const changed =
            Math.abs(with_[p] - without[p]) > 10 ||
            Math.abs(with_[p + 1] - without[p + 1]) > 10 ||
            Math.abs(with_[p + 2] - without[p + 2]) > 10 ||
            (isDrawn && !wasDrawn);
          if (!changed) continue;
          type++;
          if (wasDrawn) onShape++;
          const i = p / 4;
          const x = i % c.width;
          const y = Math.floor(i / c.width);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        return { type, onShape, tile: c.width, box: maxX < 0 ? null : { minX, minY, maxX, maxY } };
      },
      [src, "ɑ"]
    );

    const overlap = result.type ? (result.onShape / result.type) * 100 : 100;
    t.check(
      result.type > 200 && overlap < 1,
      `${label}: the phoneme sits clear of the drawing`,
      `${result.type} px of type, ${overlap.toFixed(1)}% on the shape`
    );
    if (result.box) {
      const b = result.box;
      const pc = (v) => Math.round((v / result.tile) * 100);
      t.note(`lands at ${pc(b.minX)}–${pc(b.maxX)}% across, ${pc(b.minY)}–${pc(b.maxY)}% down`);
    }
  }

  t.section("2 — and says nothing when there is nothing to say");
  const quiet = await stage.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 382;
    const ctx = c.getContext("2d");
    const d = [];
    for (let i = 0; i < 44; i++) d.push(1.1);
    const base = { d, lip: 39, a: 0.3, i: 0.9, v: 1, f: 120 };
    window.stage.drawTract(ctx, c, { frame: { ...base, p: "" } }, 0);
    const a = ctx.getImageData(0, 0, c.width, c.height).data.slice();
    ctx.clearRect(0, 0, c.width, c.height);
    window.stage.drawTract(ctx, c, { frame: base }, 0);
    const b = ctx.getImageData(0, 0, c.width, c.height).data;
    let diff = 0;
    for (let p = 0; p < a.length; p += 4) if (Math.abs(a[p + 3] - b[p + 3]) > 8) diff++;
    return diff;
  });
  t.check(quiet === 0, "an empty phoneme draws nothing — a gap reads as a breath", `${quiet} px differ`);

  t.section("3 — a player sends the phoneme it is actually on");
  const player = await t.player({ audio: true });
  await stage.evaluate(() =>
    window.stage.take({ address: "/stage/set", args: [JSON.stringify({ title: false, tracts: true, fade: 0 })] })
  );
  // the frame feed only runs while a stage is saying hello, so give it one
  await t.sleep(2500);

  // park on a cell with the gate HELD OPEN and read what the stage got. An
  // earlier version of this check sampled with the gate shut, received the
  // empty string the page correctly sends for silence, and passed anyway
  // because it only asserted the type was a string.
  const atCell = async (cell) => {
    await player.evaluate(async (c) => {
      window.scan.applyRemote("/scan/phrase", [3]);
      window.scan.applyRemote("/scan/position", [c + 0.5]);
      window.scan.applyRemote("/scan/gate", [1]);
      await new Promise((r) => setTimeout(r, 500));
    }, cell);
    const mine = await player.evaluate((c) => window.scan.cells[c].ipa, cell);
    const theirs = await stage.evaluate(() => (window.stage.frames[0] || {}).phoneme);
    return { mine, theirs };
  };

  for (const cell of [0, 3, 12]) {
    const { mine, theirs } = await atCell(cell);
    t.check(
      theirs === mine && !!mine,
      `cell ${cell}: the stage shows the phoneme the player is on`,
      `player /${mine}/, stage /${theirs}/`
    );
  }

  const closed = await player.evaluate(async () => {
    window.scan.applyRemote("/scan/gate", [0]);
    await new Promise((r) => setTimeout(r, 600));
    return true;
  });
  void closed;
  const silent = await stage.evaluate(() => (window.stage.frames[0] || {}).phoneme);
  t.check(silent === "", "and nothing at all when the gate shuts", `got ${JSON.stringify(silent)}`);
});
